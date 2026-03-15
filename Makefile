.PHONY: setup dev build test check lint format clean help remote

# デフォルト
help:
	@echo "Fude - Lightweight Markdown Editor"
	@echo ""
	@echo "Usage:"
	@echo "  make setup     依存関係を一括インストール"
	@echo "  make dev       開発モード起動"
	@echo "  make build     プロダクションビルド"
	@echo "  make test      全テスト実行"
	@echo "  make lint      全lint実行"
	@echo "  make format    全フォーマット実行"
	@echo "  make check     lint + format + test + build"
	@echo "  make remote    WSLからWindows版Fudeを起動"
	@echo "  make clean     ビルド成果物を削除"

# 依存関係インストール
setup:
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
	node scripts/serve.js

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
	sudo dpkg -i src-tauri/target/release/bundle/deb/Fude_0.1.0_amd64.deb
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

# クリーン
clean:
	rm -rf dist/bundle.js dist/index.html dist/style.css
	cd src-tauri && cargo clean
