// CodexSwitchLauncher.swift
// codex-switch — 主 App 启动器(真 AppKit 应用,编译为 Contents/MacOS/codex-switch-launcher)。
//
// 为什么不能用 shell 脚本当启动器:LaunchServices 把主 App 判为 Foreground,而 shell
// 进程永远不连接 WindowServer(lsappinfo 显示 !cgsConnection),macOS 认为它「一直在
// 启动中」,Dock 图标无限弹跳。真 AppKit 进程正常 check-in,弹跳立即停止;同时获得
// Dock 右键「退出」/ ⌘Q(applicationShouldTerminate),「从应用列表退出自动还原配置」
// 也走同一套清理逻辑。
//
// 语义与旧 sh 启动器对齐:
//  - 端口已被占 → 只打开配置页并退出(不抢已有实例);
//  - 否则加载 ~/.codex-switch/env、拉起内嵌 node 服务(输出追加 run.log),
//    并经 open -g 启动菜单栏小 .app(--launcher-pid = 本进程);
//  - 收到 SIGTERM/INT,或 Dock/⌘Q 退出 → 先 POST /__admin/codex-restore 还原注入的
//    Codex 配置,再停服务与菜单栏;
//  - server 子进程自行退出(更新流水线 kill node 后 open 重拉新版)→ 不还原直接退出,
//    与旧版一致(更新不触发还原)。

import AppKit
import Foundation

let bundlePath = Bundle.main.bundlePath
let nodeBin = bundlePath + "/Contents/MacOS/node"
let appDir = bundlePath + "/Contents/Resources/app"
let serverJs = appDir + "/src/server.js"
let cfgPath = appDir + "/config.toml"

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

func openPage() {
  if let u = URL(string: baseURL + "/") { NSWorkspace.shared.open(u) }
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
  // 先 source env(如有)再 exec node:sh 被 node 替换,子进程 pid 即 node pid,可直接 terminate
  sh.arguments = ["-c", "if [ -f \"\(envFile)\" ]; then . \"\(envFile)\"; fi; exec \"\(nodeBin)\" \"\(serverJs)\""]
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
  if restore {
    run("/usr/bin/curl", ["-fsS", "-m", "8", "-X", "POST", baseURL + "/__admin/codex-restore"])
  }
  if let s = serverChild, s.isRunning { s.terminate() }
  run("/usr/bin/pkill", ["-f", "CodexSwitchMenuBar.app/Contents/MacOS"])
}

final class LauncherDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ n: Notification) {
    if portListening() {   // 已有实例在跑(源码安装或另一个 App),只打开管理页
      openPage()
      exit(0)
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

  // 点 Dock 图标 → 打开配置页(本应用无窗口,用页面当主界面)
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
