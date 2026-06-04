# Cài đặt Penguin

Làm 3 bước, ai cũng làm được.

## Bước 1. Cài Node.js

Vào https://nodejs.org → tải bản **LTS** → cài (next next finish).

Kiểm tra: mở **Command Prompt** (gõ `cmd` ở thanh Windows), gõ:

```
node -v
```

Hiện ra số version (vd `v22.x.x`) là OK.

## Bước 2. Cài + đăng nhập Claude Code

Vẫn trong Command Prompt, gõ:

```
npm install -g @anthropic-ai/claude-code
claude
```

Lệnh `claude` mở trình duyệt → đăng nhập tài khoản Claude (gói **Max** hoặc **Pro**) → xong đóng cửa sổ.

> Không có Claude Max/Pro? Bỏ qua bước này, dùng API key OpenRouter (https://openrouter.ai/keys) — dán vào app ở mục **Settings** sau khi mở app.

## Bước 3. Chạy app

Vào thư mục **Penguin**, nhấp đúp file **`start.bat`**.

Lần đầu hơi lâu (1-2 phút cài thư viện). Sau đó trình duyệt tự mở **http://localhost:3000**.

Đặt password lần đầu (tối thiểu 4 ký tự) → vào app.

---

## Sau này

- **Mở lại app**: nhấp đúp `start.bat`.
- **Tắt app**: chạy file `stop.bat`.
- **Quên password**: mở file `password-backup.txt` trong thư mục Penguin.
- **Reset toàn bộ**: xóa folder `.data/` → mở lại app.

## Khi có bản update

Người gửi sẽ đưa anh 1 file zip (vd `mas-ai-office-20260520-1530.zip`).

1. Copy file zip vào **đúng thư mục Penguin** (chỗ có file `start.bat`).
2. Nhấp đúp file **`apply-update.bat`**.
3. Bấm `Y` khi script hỏi xác nhận → app tự dừng, giải nén, cài lib (nếu cần), khởi động lại.

Dữ liệu (chat, file đã tạo, password) trong folder `.data/` **không bị mất** sau update.
