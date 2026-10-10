# Backlog
- [ ] 2026-08-08 シンボリックリンクのファイルを開くと、タブにフォーカスは当たるがファイルの内容が表示されない。姉妹プロジェクト tana 側でもシンボリックリンクを開けない可能性あり（両方まとめて調査） #bug
- [ ] 2026-10-10 Windows 版 GUI の名前付きパイプ（`\\.\pipe\fude-<user>-gui.sock`）が存在しない。TCP 127.0.0.1:47821 は待ち受けており `fude bridge` / `fude-cli.exe` はそちらで動くが、Windows ローカルの `fude --wait`（パイプのみ使用）は動かない可能性が高い（未確認）。`gui_server::start` の Windows での挙動を調査 #bug
- [ ] 2026-10-10 同じホストへ ssh を複数本張ると RemoteForward 47821 を持てるのは最初の 1 本だけ。最初の 1 本を閉じると fude-cli が届かなくなる（ControlMaster の併用か、接続ごとのポート割り当てを検討） #remote
