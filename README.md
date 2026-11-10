# Quản lý bị can

Ứng dụng quản lý hồ sơ bị can trên iPhone. Repo có hai bản, dùng chung định dạng tệp sao lưu:

- **Bản native (SwiftUI)** trong thư mục `ios/` — build bằng Xcode trên Mac. Mở khoá bằng Face ID, có thông báo nhắc hạn.
- **Bản web (PWA)** ở thư mục gốc — cài qua Safari, không cần Mac. Phần "Tính năng", "Bảo mật", "Cài lên iPhone" bên dưới mô tả bản này.

## Bản native: build bằng Xcode

Yêu cầu: Xcode 16 trở lên, iPhone chạy iOS 17 trở lên.

1. Mở `ios/QuanLyBiCan.xcodeproj` bằng Xcode.
2. Chọn target **QuanLyBiCan → Signing & Capabilities**: chọn **Team** (Apple ID của mình) và đổi **Bundle Identifier** thành tên riêng, ví dụ `vn.tencuaban.QuanLyBiCan`.
3. Cắm iPhone, chọn máy ở thanh trên cùng, bấm **Run** (⌘R). Lần đầu cần bật Developer Mode trên iPhone và tin cậy chứng chỉ trong Cài đặt → Cài đặt chung → Quản lý VPN & thiết bị.

Với Apple ID miễn phí, app hết hạn sau 7 ngày và phải bấm Run lại (dữ liệu vẫn còn, miễn là không xoá app). Tài khoản Apple Developer trả phí thì hạn là 1 năm.

Nếu Xcode không mở được file project: tạo project mới (iOS → App, SwiftUI, tên `QuanLyBiCan`), xoá hai file Swift mẫu, kéo toàn bộ file trong `ios/QuanLyBiCan/` vào, rồi thêm khoá `Privacy - Face ID Usage Description` trong tab Info.

Khác với bản web:

- Mở khoá bằng Face ID / Touch ID / mật mã máy, không có mật khẩu riêng. Dữ liệu là tệp JSON trong vùng riêng của app, được iOS mã hoá khi máy khoá. Máy chưa đặt mật mã thì app không khoá được.
- Thông báo nhắc hạn lúc 8 giờ (bật trong Cài đặt): trước hạn theo số ngày cảnh báo và đúng ngày hết hạn. Mặc định không hiện họ tên bị can trong thông báo.
- Bản sao lưu đặt mật khẩu lúc xuất; tệp `.json` này khôi phục được ở cả hai bản.

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
