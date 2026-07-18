# Fude 動作確認用イメージ（自己完結・ホスト非マウント）
# - Tauri v2 のビルド依存 + ヘッドレス表示(Xvfb) + noVNC でGUI確認
# - 非rootユーザで実行。ファイル操作は使い捨てサンドボックス上で行う
FROM node:22-bookworm

# Tauri / WebKitGTK / 仮想ディスプレイ / VNC の依存
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev \
    build-essential curl wget file libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config \
    xvfb x11vnc fluxbox novnc websockify \
    dbus-x11 ca-certificates git \
    # 日本語表示（化け対策）
    fonts-noto-cjk fonts-noto-color-emoji \
    # キーボード/フォーカス（入力対策）
    x11-xkb-utils x11-xserver-utils xdotool \
 && rm -rf /var/lib/apt/lists/*

# 非rootユーザ
RUN useradd -ms /bin/bash fude
USER fude
ENV HOME=/home/fude
WORKDIR /home/fude/app

# Rust（ユーザ領域にインストール）
ENV RUSTUP_HOME=/home/fude/.rustup \
    CARGO_HOME=/home/fude/.cargo \
    PATH=/home/fude/.cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal

# 依存を先に入れてレイヤキャッシュ
COPY --chown=fude:fude package.json package-lock.json ./
RUN npm ci || npm install

# ソース投入 → フロントビルド → debug バイナリを事前ビルド（初回起動を高速化）
COPY --chown=fude:fude . .
RUN npm run build:frontend \
 && cargo build --manifest-path src-tauri/Cargo.toml

# ヘッドレス WebKit 向け設定
ENV DISPLAY=:99 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    NO_AT_BRIDGE=1

EXPOSE 6080
ENTRYPOINT ["bash", "docker/entrypoint.sh"]
CMD ["gui"]
