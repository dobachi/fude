.PHONY: setup doctor install-rust dev build test check lint format clean help remote release

# OS判定
UNAME_S := $(shell uname -s)

# Linux (Debian/Ubuntu) で必要な apt パッケージ
APT_DEPS := libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config

# デフォルト
help:
	@echo "Fude - Lightweight Markdown Editor"
	@echo ""
	@echo "Usage:"
	@echo "  make doctor       開発環境の前提条件をチェック"
	@echo "  make install-rust rustup で Rust をインストール（未導入時のみ）"
	@echo "  make setup        依存関係を一括インストール（doctor 後に実行）"
	@echo "  make dev          開発モード起動"
	@echo "  make build        プロダクションビルド"
	@echo "  make test         全テスト実行"
	@echo "  make lint         全lint実行"
	@echo "  make format       全フォーマット実行"
	@echo "  make check        lint + format + test + build"
	@echo "  make remote       WSLからWindows版Fudeを起動"
	@echo "  make release      全OS向けリリースビルド（CIでビルド）"
	@echo "  make clean        ビルド成果物を削除"

# 環境チェック（Node / Rust / Linuxの場合は apt パッケージ）
doctor:
	@echo "==> 開発環境をチェックします..."
	@missing=0; \
	if command -v node >/dev/null 2>&1; then \
		echo "  ✓ node $$(node --version)"; \
	else \
		echo "  ✗ node が見つかりません (https://nodejs.org または nvm を利用)"; \
		missing=1; \
	fi; \
	if command -v npm >/dev/null 2>&1; then \
		echo "  ✓ npm $$(npm --version)"; \
	else \
		echo "  ✗ npm が見つかりません"; \
		missing=1; \
	fi; \
	if command -v cargo >/dev/null 2>&1; then \
		echo "  ✓ cargo $$(cargo --version | awk '{print $$2}')"; \
	else \
		echo "  ✗ cargo (Rust) が見つかりません"; \
		echo "    → make install-rust  または  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"; \
		echo "    インストール後: source \"\$$HOME/.cargo/env\""; \
		missing=1; \
	fi; \
	if [ "$(UNAME_S)" = "Linux" ]; then \
		if command -v dpkg >/dev/null 2>&1; then \
			missing_pkgs=""; \
			for pkg in $(APT_DEPS); do \
				if ! dpkg -s "$$pkg" >/dev/null 2>&1; then \
					missing_pkgs="$$missing_pkgs $$pkg"; \
				fi; \
			done; \
			if [ -n "$$missing_pkgs" ]; then \
				echo "  ✗ 不足しているaptパッケージ:$$missing_pkgs"; \
				echo "    → sudo apt-get update && sudo apt-get install -y$$missing_pkgs"; \
				missing=1; \
			else \
				echo "  ✓ aptパッケージは揃っています"; \
			fi; \
		else \
			echo "  ⚠ dpkg が無いため apt 依存チェックをスキップ（非Debian系？対応するパッケージを各自導入してください）"; \
		fi; \
	elif [ "$(UNAME_S)" = "Darwin" ]; then \
		echo "  ℹ macOS: 追加のシステム依存は通常不要（Xcode Command Line Tools が必要）"; \
	else \
		echo "  ℹ $(UNAME_S): aptチェック対象外（必要に応じて Tauri 公式ガイドを参照）"; \
	fi; \
	if [ $$missing -ne 0 ]; then \
		echo ""; \
		echo "✗ 前提条件が不足しています。上記コマンドで導入後、再度実行してください。"; \
		exit 1; \
	fi; \
	echo "✓ 環境チェック OK"

# Rust を rustup でインストール（未導入時のみ）
install-rust:
	@if command -v cargo >/dev/null 2>&1; then \
		echo "Rust は既にインストール済みです: $$(cargo --version)"; \
	else \
		echo "==> rustup で Rust をインストールします..."; \
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile default; \
		echo ""; \
		echo "==> インストール完了。現在のシェルで使うには:"; \
		echo "    source \"\$$HOME/.cargo/env\""; \
	fi

# 依存関係インストール（doctor で事前チェック）
setup: doctor
	@echo "==> Node.js依存をインストール..."
	npm install
	@echo "==> Rustビルド確認..."
	cargo build --manifest-path src-tauri/Cargo.toml
	@echo "==> セットアップ完了"

# 開発モード（Tauriネイティブ）
dev:
	npm run build:frontend
	npx tauri dev

# ブラウザモード（WSL向け、日本語IME対応）
browser:
	npm run build:frontend
	FUDE_OPEN_DIR="$(PWD)" node scripts/serve.js

# フロントエンドのみビルド
build-frontend:
	npm run build:frontend

# プロダクションビルド（AppImage失敗はWSL環境では正常）
build:
	npm run build:frontend
	npx tauri build || echo "Note: Some bundle targets may have failed (e.g., AppImage on WSL). Check output above."

# テスト
test: test-js test-rust

test-js:
	npx vitest run

test-rust:
	cd src-tauri && cargo test --lib

# Lint
lint: lint-js lint-rust

lint-js:
	npx eslint src/js/

lint-rust:
	cd src-tauri && cargo clippy -- -D warnings

# フォーマット
format: format-js format-rust

format-js:
	npx prettier --write 'src/**/*.{js,css,html}'

format-rust:
	cd src-tauri && cargo fmt

format-check:
	npx prettier --check 'src/**/*.{js,css,html}'
	cd src-tauri && cargo fmt --check

# 全チェック（CI向け）
check: format-check lint test build-frontend

# インストール（dpkg + ブラウザモード）
install: build
	sudo dpkg -i src-tauri/target/release/bundle/deb/Fude_*_amd64.deb
	sudo mkdir -p /usr/lib/fude
	sudo cp dist/* /usr/lib/fude/
	sudo cp scripts/serve.js /usr/lib/fude/
	sudo cp scripts/fude-browser /usr/bin/fude-browser

# アンインストール
uninstall:
	sudo dpkg -r fude
	sudo rm -rf /usr/lib/fude
	sudo rm -f /usr/bin/fude-browser

# リモートモード（WSLからWindows版Fudeを起動）
remote:
	npm run build:frontend
	bash scripts/fude-remote

# リリース（事前チェック + バージョン更新 + lockfile 同期 + タグ + CIビルド）
# 各ステップが失敗したら以降を実行しない（&& chain）
release:
	@read -p "New version (e.g., 0.2.0): " ver && \
	echo "==> Pre-release check: make check" && \
	$(MAKE) check && \
	echo "==> Bumping version to v$$ver" && \
	sed -i "s/\"version\": \".*\"/\"version\": \"$$ver\"/" src-tauri/tauri.conf.json && \
	sed -i "s/^version = \".*\"/version = \"$$ver\"/" src-tauri/Cargo.toml && \
	sed -i "s/\"version\": \".*\"/\"version\": \"$$ver\"/" package.json && \
	echo "==> Syncing package-lock.json" && \
	npm install --package-lock-only --silent && \
	echo "==> Syncing Cargo.lock" && \
	(cd src-tauri && cargo check --quiet) && \
	echo "==> Committing release (only version + lock files)" && \
	git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock package.json package-lock.json && \
	git commit -m "release: v$$ver" && \
	git push && \
	git tag "v$$ver" && \
	git push origin "v$$ver" && \
	echo "==> v$$ver tagged and pushed. CI will build all platforms."

# クリーン
clean:
	rm -rf dist/bundle.js dist/index.html dist/style.css
	cd src-tauri && cargo clean
