// CodexSwitchMenuBar.swift
// codex-switch — macOS 菜单栏常驻小程序(随 App 打包,由启动器拉起)。
//
// 职责(只读监视 + 快捷入口,不管理服务进程):
//  - 状态栏小图标:服务可达=正常,不可达=图标变暗;
//  - 每 5s 轮询 /__admin/health,菜单里显示 版本·供应商数·模型数·运行时长;
//  - 菜单:打开配置页 / 检查更新(发现新版可一键触发 /__admin/update/run)/ 隐藏图标 / 退出;
//  - 「退出」= 向父进程(启动器)发 SIGTERM,由其先还原注入的 Codex 配置再停服务;
//  - 父进程(启动器)消失后自动退出,不留孤儿图标;
//  - 无 Dock 图标、无窗口:activation policy = accessory。

import AppKit
import Foundation

// ---------- 启动参数 ----------
func argValue(_ name: String) -> String? {
  let args = CommandLine.arguments
  for i in 0..<args.count where args[i] == name {
    if i + 1 < args.count { return args[i + 1] }
  }
  return nil
}

let port = argValue("--port") ?? "8787"
let baseURL = "http://127.0.0.1:\(port)"

// 菜单栏图标:与 App 图标(logo.svg)同形 —— 左侧入口 → 中间分支点 → 两个向右箭头。
// 自定义绘制(不依赖 SF Symbol 的方向变体),模板模式自动适配深/浅色菜单栏。
func forkIcon() -> NSImage {
  let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
    NSColor.black.setFill()
    NSColor.black.setStroke()
    let lines = NSBezierPath()
    lines.lineWidth = 1.7
    lines.lineCapStyle = .round
    lines.move(to: NSPoint(x: 1.0, y: 9.0))      // 主干(入口 → 分支点)
    lines.line(to: NSPoint(x: 7.5, y: 9.0))
    lines.move(to: NSPoint(x: 7.5, y: 9.0))      // 上分支
    lines.line(to: NSPoint(x: 13.4, y: 13.8))
    lines.move(to: NSPoint(x: 7.5, y: 9.0))      // 下分支
    lines.line(to: NSPoint(x: 13.4, y: 4.2))
    lines.stroke()
    func arrowhead(tipY: CGFloat) {              // 向右的箭头(与 App 图标一致)
      let t = NSBezierPath()
      t.move(to: NSPoint(x: 17.4, y: tipY))
      t.line(to: NSPoint(x: 13.2, y: tipY - 1.9))
      t.line(to: NSPoint(x: 13.2, y: tipY + 1.9))
      t.close()
      t.fill()
    }
    arrowhead(tipY: 13.8)
    arrowhead(tipY: 4.2)
    NSBezierPath(ovalIn: NSRect(x: 0.4, y: 7.7, width: 2.6, height: 2.6)).fill()   // 入口圆点
    NSBezierPath(ovalIn: NSRect(x: 6.2, y: 7.7, width: 2.6, height: 2.6)).fill()   // 分支点圆点
    return true
  }
  img.isTemplate = true
  return img
}

final class MenuBarController: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var stateItem: NSMenuItem!
  private var session: URLSession!

  func applicationDidFinishLaunching(_ notification: Notification) {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 3
    cfg.timeoutIntervalForResource = 6
    session = URLSession(configuration: cfg)

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let btn = statusItem.button {
      btn.image = forkIcon()    // 自定义向右分叉图形,与 App 图标一致;模板图适配深浅色
      btn.toolTip = "Codex Switch — 检测中…"
    }

    let menu = NSMenu()
    stateItem = NSMenuItem(title: "检测中…", action: nil, keyEquivalent: "")
    menu.addItem(stateItem)
    menu.addItem(.separator())

    let openItem = NSMenuItem(title: "打开配置页", action: #selector(openPage), keyEquivalent: "o")
    openItem.target = self
    menu.addItem(openItem)

    let updItem = NSMenuItem(title: "检查更新…", action: #selector(checkUpdate), keyEquivalent: "u")
    updItem.target = self
    menu.addItem(updItem)

    menu.addItem(.separator())
    let hideItem = NSMenuItem(title: "隐藏图标", action: #selector(hideIcon), keyEquivalent: "")
    hideItem.target = self
    menu.addItem(hideItem)

    let quitItem = NSMenuItem(title: "退出 Codex Switch(自动还原配置)", action: #selector(quitApp), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)

    statusItem.menu = menu

    let t = Timer(timeInterval: 5, repeats: true) { [weak self] _ in self?.poll() }
    RunLoop.main.add(t, forMode: .common)   // .common:菜单展开时也继续刷新
    poll()
  }

  // 父进程(启动器)已不在 → App 已退出,自动撤离(防 kill -9 后残留孤儿图标)
  private func orphaned() -> Bool { getppid() == 1 }

  private func poll() {
    if orphaned() { NSApp.terminate(nil); return }
    guard let url = URL(string: baseURL + "/__admin/health") else { return }
    session.dataTask(with: url) { [weak self] data, _, err in
      DispatchQueue.main.async {
        guard let self else { return }
        var ok = false
        var detail = "服务未响应(\(baseURL))"
        var updating: String?
        if err == nil, let data,
           let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           (j["ok"] as? Bool) == true {
          ok = true
          let ver = j["version"] as? String ?? "?"
          let provs = j["providers"] as? Int ?? 0
          let models = j["models"] as? Int ?? 0
          let up = j["uptime"] as? Int ?? 0
          updating = j["updating"] as? String
          detail = updating != nil
            ? "更新中(\(updating!))…"
            : "运行中 v\(ver) · \(provs) 供应商 · \(models) 模型 · \(up)s"
        }
        self.stateItem.title = detail
        self.statusItem.button?.alphaValue = ok ? 1.0 : 0.35
        self.statusItem.button?.toolTip = ok
          ? (updating != nil ? "Codex Switch — 更新中" : "Codex Switch — 运行中")
          : "Codex Switch — 服务未响应"
      }
    }.resume()
  }

  @objc private func openPage() {
    if let url = URL(string: baseURL + "/") { NSWorkspace.shared.open(url) }
  }

  @objc private func hideIcon() { NSApp.terminate(nil) }

  // 退出:给父进程(启动器)发 SIGTERM —— 启动器的 trap 会先调 /__admin/codex-restore
  // 把注入的 Codex 配置还原(最新备份覆盖回 ~/.codex/),再停掉服务与本菜单栏进程。
  @objc private func quitApp() {
    kill(getppid(), SIGTERM)
    NSApp.terminate(nil)
  }

  @objc private func checkUpdate() {
    guard let url = URL(string: baseURL + "/__admin/update/check") else { return }
    session.dataTask(with: url) { [weak self] data, _, err in
      DispatchQueue.main.async {
        guard let self else { return }
        var msg: String
        var canRun = false
        if err == nil, let data,
           let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
          let cur = j["current"] as? String ?? "?"
          if (j["ok"] as? Bool) == true, (j["newer"] as? Bool) == true {
            let latest = j["latest"] as? String ?? "?"
            msg = "发现新版本 v\(latest)(当前 v\(cur))。\n点「立即更新」后自动下载并安装,进度见配置页,完成后自动重启。"
            canRun = true
          } else if (j["ok"] as? Bool) == true {
            msg = "当前已是最新版本 v\(cur)。"
          } else {
            msg = "检查更新失败:\(j["error"] as? String ?? "未知错误")"
          }
        } else {
          msg = "无法连接服务(\(baseURL)),未能检查更新。"
        }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Codex Switch 检查更新"
        alert.informativeText = msg
        if canRun {
          alert.addButton(withTitle: "立即更新")
          alert.addButton(withTitle: "取消")
          if alert.runModal() == .alertFirstButtonReturn { self.runUpdate() }
        } else {
          alert.addButton(withTitle: "好")
          alert.runModal()
        }
      }
    }.resume()
  }

  private func runUpdate() {
    guard let url = URL(string: baseURL + "/__admin/update/run") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = "{}".data(using: .utf8)
    session.dataTask(with: req) { data, _, err in
      DispatchQueue.main.async {
        if err != nil {
          // 更新流水线可能已重启服务导致连接中断;打开配置页看进度即可
          if let u = URL(string: baseURL + "/") { NSWorkspace.shared.open(u) }
          return
        }
        var failedWith: String?
        if let data, let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
          if (j["ok"] as? Bool) != true { failedWith = j["error"] as? String ?? "启动失败" }
        } else {
          failedWith = "响应解析失败"
        }
        if let failedWith {
          NSApp.activate(ignoringOtherApps: true)
          let a = NSAlert()
          a.messageText = "未能启动更新"
          a.informativeText = failedWith
          a.addButton(withTitle: "好")
          a.runModal()
        } else {
          if let u = URL(string: baseURL + "/") { NSWorkspace.shared.open(u) }  // 去配置页看下载进度条
        }
      }
    }.resume()
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = MenuBarController()
app.delegate = controller
app.run()
