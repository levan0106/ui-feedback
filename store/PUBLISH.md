# Publish extension — Edge Add-ons + Chrome Web Store (unlisted)

## 0. Chuẩn bị (một lần)
1. Đẩy repo lên GitHub (công khai). Thay `<REPO_URL>` và `<CONTACT_EMAIL_OR_REPO_ISSUES_URL>` trong `store/LISTING.md`, `store/PRIVACY.md`.
2. Privacy policy cần URL công khai: dùng `<REPO_URL>/blob/main/store/PRIVACY.md` (hoặc bật GitHub Pages).
3. Chụp 1–5 screenshot 1280×800 từ app đang chạy (khung chat + chọn phần tử). Có thể bắt đầu từ `tests/e2e-extension/*.png`.
4. Tạo tài khoản:
   - Edge: https://partner.microsoft.com/dashboard/microsoftedge (miễn phí, cần tài khoản Microsoft).
   - Chrome: https://chrome.google.com/webstore/devconsole (phí $5 một lần, cần xác minh email + 2FA).

## 1. Build gói
```
npm test
npm run pack        # → dist/ui-feedback-bridge-<version>.zip
```
Script từ chối build nếu thiếu icon, version lệch `package.json`, hoặc có `permissions` thừa. Cùng một nguồn ra cùng một zip (tái lập được).

## 2. Edge Add-ons (làm trước, duyệt nhanh, miễn phí)
1. Partner Center → **Microsoft Edge** → **Create new extension** → upload zip.
2. Availability: **Public** (Edge không có unlisted thật sự; có thể chọn **Hidden** để chỉ ai có link mới cài được).
3. Dán Name/Description/Category từ `LISTING.md`, upload screenshot + logo 300×300, điền Privacy policy URL.
4. Notes for certification: dán "Giải trình quyền" + "Cần chạy local bridge: <REPO_URL>#cài-đặt" để reviewer hiểu vì sao cần localhost.
5. Submit → thường vài ngày làm việc. Chrome không cài được từ Edge Add-ons (chỉ nhận từ Chrome Web Store), nên vẫn cần bước 3.

## 3. Chrome Web Store (Unlisted)
1. Developer Dashboard → **Add new item** → upload zip.
2. **Store listing**: dán mô tả, category Developer Tools, upload icon + screenshot (+ promo tile 440×280).
3. **Privacy practices**: Single purpose, Permission justification, Data usage (xem `LISTING.md`); URL privacy policy; tích 3 cam kết.
4. **Distribution** → Visibility: **Unlisted**; Regions: tất cả.
5. **Submit for review**. Host access vào localhost thường qua review nhanh; nếu bị hỏi "world MAIN", dùng đoạn giải trình trong `LISTING.md`.
6. Sau khi duyệt: lấy link `https://chromewebstore.google.com/detail/<id>` và ghi vào README (xem mục dưới).

## 4. Sau khi được duyệt
- Cập nhật README mục **Cài đặt**: bước 2 thành "cài từ Chrome Web Store (link) / Edge Add-ons (link)"; giữ Load unpacked như phương án dự phòng.
- Cập nhật phiên bản: tăng `version` ở **cả** `extension/manifest.json` và `package.json` (test sẽ báo nếu lệch) → `npm test && npm run pack` → upload zip mới ở mỗi store (**Package → Upload new package**). Store tự cập nhật cho người dùng.

## 5. Lưu ý quan trọng
- Extension chỉ là nửa phía trình duyệt. Người cài vẫn cần Node ≥ 20 và chạy bridge (`node bridge/cli.mjs install`). Hãy giữ mô tả store nói rõ điều này để tránh review 1 sao "không chạy".
- Overlay đi cùng zip, **không** tải từ bridge lúc chạy (MV3 cấm remote code). Sửa `extension/overlay.js` xong phải build và nộp lại bản mới thì người dùng store mới nhận được.
- Đổi `BRIDGE` mặc định (cổng 47831) sẽ cần cập nhật `store/PRIVACY.md` và `LISTING.md` cho khớp.
