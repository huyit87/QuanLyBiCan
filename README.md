# Quản lý bị can

Ứng dụng quản lý hồ sơ bị can chạy trên iPhone, dạng web app cài lên màn hình chính (PWA). Không cần Mac, Xcode hay App Store.

## Tính năng

- Hồ sơ bị can: lý lịch, ảnh, vụ án, tội danh, quyết định khởi tố, biện pháp ngăn chặn, điều tra viên / kiểm sát viên thụ lý, ghi chú.
- Theo dõi thời hạn tạm giữ, tạm giam và các lần gia hạn; cảnh báo hạn sắp hết / quá hạn ở màn hình Tổng quan.
- Tìm kiếm không dấu, lọc theo biện pháp ngăn chặn và giai đoạn tố tụng, nhóm bị can theo vụ án.
- Xuất bản sao lưu đã mã hoá (`.qlbc`), khôi phục, xuất danh sách ra Excel (CSV).
- Chạy được khi không có mạng.

## Bảo mật

- Dữ liệu chỉ lưu trên máy (IndexedDB), không có máy chủ, không gửi đi đâu.
- Mỗi hồ sơ được mã hoá AES-256-GCM bằng khoá dẫn xuất từ mật khẩu (PBKDF2-SHA256, 310.000 vòng).
- Tự khoá sau 1 phút rời khỏi ứng dụng.
- **Quên mật khẩu là mất dữ liệu.** Hãy xuất bản sao lưu định kỳ. Tệp CSV không được mã hoá.
- Việc lưu thông tin vụ án trên thiết bị cá nhân cần tuân theo quy định bảo mật của đơn vị.

## Cài lên iPhone

Ứng dụng phải được mở qua địa chỉ HTTPS:

1. Trên GitHub: **Settings → Pages → Deploy from a branch**, chọn nhánh chứa mã nguồn, thư mục `/ (root)`. (Repo riêng tư cần gói GitHub trả phí để dùng Pages; có thể thay bằng dịch vụ lưu trữ tệp tĩnh HTTPS bất kỳ.)
2. Mở địa chỉ Pages bằng **Safari** trên iPhone.
3. Bấm nút Chia sẻ → **Thêm vào MH chính**.
4. Mở ứng dụng từ màn hình chính và đặt mật khẩu.

Dữ liệu gắn với địa chỉ web và máy đã cài; đổi địa chỉ hoặc xoá ứng dụng thì phải khôi phục từ bản sao lưu.

## Chạy thử trên máy tính

```
python3 -m http.server 8000
```

Mở <http://localhost:8000>.

## Cập nhật

Sau khi sửa mã nguồn, tăng `VERSION` trong `sw.js` để iPhone tải bản mới.
