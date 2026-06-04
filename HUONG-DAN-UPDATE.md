# Cách cập nhật Penguin

## Cách 1 — Tự động từ GitHub (khuyến nghị)

Cách dễ nhất, không cần file zip:

1. Trong app → bấm nút ⚙ **Settings** (góc trên sidebar trái).
2. Vào tab **Update**. Nếu có chấm xanh nhỏ trên ⚙ Settings → đã có bản mới.
3. Khi thấy card xanh **"Version X.Y.Z available"** → bấm **Download & install**.
4. Đợi ~60-90s (app tự tải zip từ GitHub, giải nén, cài thư viện — trạng thái hiện trong tab).
5. Bấm **Restart Penguin** → trang tự reload, ~10-15s sau quay lại login.
6. Login như bình thường. Chat, file, mật khẩu giữ nguyên.

Hoặc bấm **Check now** bất cứ lúc nào để kiểm tra thủ công.

## Cách 2 — Từ file zip có sẵn

Nếu ai đó gửi trực tiếp file `AGENT-P_v*.zip` (qua chat / email / USB):

1. ⚙ **Settings** → tab **Update** → kéo-thả file zip vào ô **"Or install from a local zip"** (hoặc bấm để chọn).
2. App upload → giải nén → cài thư viện → bấm **Restart Penguin**.

## Cách 3 — `apply-update.bat` (cách cũ, vẫn chạy)

1. Copy file zip vào folder Penguin (chỗ có `start.bat`).
2. Đúp **`apply-update.bat`** → bấm `Y` → đợi 30-60s → app tự khởi động lại.

## Dữ liệu có mất không?

**Không.** Folder `.data/` (chat history, file đã tạo, password DB) và `password-backup.txt` **không bao giờ** bị đụng tới khi update.

## Lỡ giải nén zip ra folder mới?

Đúp `start.bat` trong folder mới — launcher tự dò folder Penguin cũ, **copy chat history + mật khẩu + shortcut** sang folder mới. Xác nhận chạy ổn rồi xóa folder cũ thủ công.

## Sự cố thường gặp

- **Quên password**: mở `password-backup.txt` trong folder Penguin.
- **App không tự mở lại sau Restart**: đợi thêm 20-30s, hoặc đúp `start.bat` thủ công.
- **Update báo lỗi**: chụp màn hình + báo người gửi zip. Có thể rollback bằng cách dùng Cách 3 với zip version cũ.
