// CodexSwitchLauncher.swift
// codex-switch — 主 App 启动器(真 AppKit 应用,编译为 Contents/MacOS/codex-switch-launcher)。
//
// 为什么不能用 shell 脚本当启动器:LaunchServices 把主 App 判为 Foreground,而 shell
// 进程永远不连接 WindowServer(lsappinfo 显示 !cgsConnection),macOS 认为它「一直在
// 启动中」,Dock 图标无限弹跳。真 AppKit 进程正常 check-in,弹跳立即停止;同时获得
// Dock 右键「退出」/ ⌘Q(applicationShouldTerminate),「从应用列表退出自动还原配置」
// 也走同一套清理逻辑。
//
// 服务生命周期保持原有语义:
//  - 端口已被占 → 只打开原生配置窗口,不接管已有服务;
//  - 否则加载 ~/.codex-switch/env、拉起内嵌 node 服务(输出追加 run.log),
//    并经 open -g 启动菜单栏小 .app(--launcher-pid = 本进程);
//  - 收到 SIGTERM/INT,或 Dock/⌘Q 退出 → 先 POST /__admin/codex-restore 还原注入的
//    Codex 配置,再停服务与菜单栏;
//  - server 子进程自行退出(更新流水线 kill node 后 open 重拉新版)→ 不还原直接退出,
//    与旧版一致(更新不触发还原)。

import AppKit
import Foundation
import WebKit

let bundlePath = Bundle.main.bundlePath
let nodeBin = bundlePath + "/Contents/MacOS/node"
let appDir = bundlePath + "/Contents/Resources/app"
let serverJs = appDir + "/src/server.js"
let cfgPath = appDir + "/config.toml"
let launchServer = appDir + "/scripts/launch-server.sh"

// 从 config.toml 读端口(listen = "127.0.0.1:8787"),读不到回退 8787
func configPort() -> String {
  if let txt = try? String(contentsOfFile: cfgPath, encoding: .utf8),
     let m = txt.range(of: #"listen\s*=\s*"[0-9.]*:(\d+)""#, options: .regularExpression) {
    let s = String(txt[m])
    if let c = s.split(separator: ":").last?.split(separator: "\"").first { return String(c) }
  }
  return "8787"
}
let port = configPort()
let baseURL = "http://127.0.0.1:\(port)"
let home = FileManager.default.homeDirectoryForCurrentUser.path
let envFile = home + "/.codex-switch/env"
let runLog = home + "/.codex-switch/run.log"

func portListening() -> Bool {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
  p.arguments = ["-tnP", "-iTCP:\(port)", "-sTCP:LISTEN"]
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  do { try p.run(); p.waitUntilExit(); return p.terminationStatus == 0 } catch { return false }
}

// 同步执行外部命令(清理路径用),不抛异常
@discardableResult
func run(_ path: String, _ args: [String], wait: Bool = true) -> Int32 {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: path)
  p.arguments = args
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  do {
    try p.run()
    if wait { p.waitUntilExit(); return p.terminationStatus }
  } catch {}
  return 0
}

var serverChild: Process?
var cleaningUp = false
let windowController = SettingsWindowController()

func openPage() {
  windowController.show()
}

// Reuse the local UI in one native window, without opening a browser tab.
final class SettingsWindowController: NSObject, WKNavigationDelegate, WKUIDelegate {
  private var window: NSWindow?

  func show() {
    if window == nil {
      let view = WKWebView(frame: .zero)
      view.navigationDelegate = self
      view.uiDelegate = self
      let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 800),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
      panel.title = "Codex Switch"
      panel.minSize = NSSize(width: 560, height: 520)
      panel.backgroundColor = .windowBackgroundColor
      panel.contentView = view
      panel.isReleasedWhenClosed = false
      panel.center()
      panel.setFrameAutosaveName("CodexSwitchSettings")
      window = panel
      view.load(URLRequest(url: URL(string: baseURL + "/")!))
    }
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { decisionHandler(.cancel); return }
    if url.scheme == "http", url.host == "127.0.0.1", url.port == Int(port),
       action.targetFrame?.isMainFrame == true {
      decisionHandler(.allow)
    } else {
      if action.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") {
        NSWorkspace.shared.open(url)
      }
      decisionHandler(.cancel)
    }
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = "Codex Switch"
    alert.informativeText = message
    alert.addButton(withTitle: "好")
    guard let window else { completionHandler(); return }
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = "确认操作"
    alert.informativeText = message
    alert.addButton(withTitle: "确认")
    alert.addButton(withTitle: "取消")
    guard let window else { completionHandler(false); return }
    alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
  }
}

func startMenubar() {
  let src = bundlePath + "/Contents/Resources/CodexSwitchMenuBar.app"
  let dst = home + "/.codex-switch/CodexSwitchMenuBar.app"
  guard FileManager.default.fileExists(atPath: src) else { return }
  run("/usr/bin/pkill", ["-f", "CodexSwitchMenuBar.app/Contents/MacOS"])
  usleep(300_000)
  try? FileManager.default.removeItem(atPath: dst)
  try? FileManager.default.copyItem(atPath: src, toPath: dst)
  run("/usr/bin/open", ["-g", dst, "--args", "--port", port, "--launcher-pid", "\(getpid())"], wait: false)
}

func startServer() {
  try? FileManager.default.createDirectory(atPath: home + "/.codex-switch", withIntermediateDirectories: true)
  if !FileManager.default.fileExists(atPath: runLog) {
    FileManager.default.createFile(atPath: runLog, contents: nil)
  }
  guard let logHandle = FileHandle(forWritingAtPath: runLog) else { return }
  logHandle.seekToEndOfFile()
  let sh = Process()
  sh.executableURL = URL(fileURLWithPath: "/bin/sh")
  // 固定脚本通过 argv 接收路径,不把任何文件系统路径拼进 shell 源码。
  // launch-server.sh 最终 exec node,所以子进程 pid 即 node pid,可直接 terminate。
  sh.arguments = [launchServer, envFile, nodeBin, serverJs]
  sh.standardOutput = logHandle
  sh.standardError = logHandle
  do { try sh.run() } catch { return }
  serverChild = sh
  sh.terminationHandler = { _ in
    // server 自行退出 = 更新流水线 kill node 后 open 重拉新版:不还原,直接退(与旧 sh 启动器 wait 返回后退出一致)
    if !cleaningUp { exit(0) }
  }
}

// 退出清理:restore=true 时先还原注入的 Codex 配置,再停服务与菜单栏
func cleanup(restore: Bool) {
  if cleaningUp { return }
  cleaningUp = true
  // Attaching a window to an existing service does not transfer its ownership.
  guard serverChild != nil else { return }
  if restore {
    run("/usr/bin/curl", ["-fsS", "-m", "8", "-X", "POST", baseURL + "/__admin/codex-restore"])
  }
  if let s = serverChild, s.isRunning { s.terminate() }
  run("/usr/bin/pkill", ["-f", "CodexSwitchMenuBar.app/Contents/MacOS"])
}

final class LauncherDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ n: Notification) {
    let mainMenu = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "退出 Codex Switch", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    mainMenu.addItem(appItem)
    let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
    let editMenu = NSMenu(title: "编辑")
    for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
      editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
    }
    editItem.submenu = editMenu
    mainMenu.addItem(editItem)
    let windowItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
    let windowMenu = NSMenu(title: "窗口")
    windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowItem.submenu = windowMenu
    mainMenu.addItem(windowItem)
    NSApp.windowsMenu = windowMenu
    NSApp.mainMenu = mainMenu
    DistributedNotificationCenter.default().addObserver(self, selector: #selector(showSettings),
      name: Notification.Name("CodexSwitchOpenSettings"), object: String(getpid()))
    if portListening() {   // 已有实例在跑(源码安装或另一个 App),只打开管理页
      openPage()
      return
    }
    startServer()
    startMenubar()
    // 等端口就绪(最多 ~8s)再开页面;server 提前退出则放弃
    DispatchQueue.global(qos: .userInitiated).async {
      for _ in 0..<20 {
        if portListening() { break }
        if !(serverChild?.isRunning ?? false) { break }
        usleep(400_000)
      }
      DispatchQueue.main.async { openPage() }
    }
  }

  @objc private func showSettings() { openPage() }

  // Closing the window keeps the proxy running; Dock and menu bar reopen it.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  // 点 Dock 图标 → 重新打开配置窗口
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    openPage()
    return true
  }

  // Dock 右键「退出」/ ⌘Q → 先还原配置再退
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    cleanup(restore: true)
    return .terminateNow
  }
}

// SIGTERM(菜单栏「退出」、launchd unload)/ SIGINT → 同样先还原再退
for sig in [SIGTERM, SIGINT] {
  signal(sig, SIG_IGN)   // DispatchSource 接管前必须忽略默认动作
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler { cleanup(restore: true); exit(0) }
  src.resume()
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)   // 真 Foreground App:Dock 可见、图标不弹跳
let delegate = LauncherDelegate()
app.delegate = delegate
app.run()
