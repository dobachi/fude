.PHONY: setup dev build test check lint format clean help

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
	@echo "  make clean     ビルド成果物を削除"

# 依存関係インストール
setup:
	@echo "==> Node.js依存をインストール..."
	npm install
	@echo "==> Rustビルド確認..."
	cargo build --manifest-path src-tauri/Cargo.toml
	@echo "==> セットアップ完了"

# 開発モード
dev:
	npm run build:frontend
	cargo tauri dev

# フロントエンドのみビルド
build-frontend:
	npm run build:frontend

# プロダクションビルド
build:
	npm run build:frontend
	cargo tauri build

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

# クリーン
clean:
	rm -rf dist/bundle.js dist/index.html dist/style.css
	cd src-tauri && cargo clean
