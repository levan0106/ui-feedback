---
name: tl-ui-feedback
description: Nhận phản hồi UI trực tiếp từ trình duyệt của người dùng (họ click phần tử sai và gõ ghi chú) và sửa code theo. Dùng khi người dùng nói "chỉ vào UI trên browser", "tôi sẽ chọn phần tử sai", "chờ feedback UI", "tl-ui-feedback", "mở site để tôi chỉ UI", "tl-ui-feedback serve", hoặc khi đang lặp sửa giao diện và muốn tránh chụp hình.
---

# UI Feedback Bridge

Người dùng bật overlay trên trang dev (extension hoặc dòng dev-only), click phần tử sai, gõ ghi chú. Bạn nhận payload gồm ghi chú, selector, style, chuỗi component và **file:dòng nguồn**.

## Gọi nhanh: `/tl-ui-feedback ...`
Khi người dùng gọi skill với đối số, tự làm hết các bước bên dưới, không hỏi lại trừ khi thiếu thông tin.

Đối số gồm **site** (cổng dev server, URL, hoặc thư mục/file HTML) và tùy chọn **cổng overlay** (cổng của trang có nút Feedback, do `serve` mở). Hai cổng này KHÁC nhau: người dùng mở trang ở cổng overlay, không mở cổng dev server (mở thẳng cổng dev server thì không có nút Feedback).

| Người dùng gõ | Ý nghĩa | Lệnh agent chạy |
|---|---|---|
| `/tl-ui-feedback <site>` | site đã chạy; số cổng `N` = `http://localhost:N`; cổng overlay tự chọn | `tl-ui-feedback serve <site>` |
| `/tl-ui-feedback <site> <cổng>` hoặc `/tl-ui-feedback <cổng> <site>` | như trên, cổng overlay cố định. Nhận cả hai thứ tự | `tl-ui-feedback serve <cổng> <site>` |
| `/tl-ui-feedback <N1> <N2>` (cả hai là số) | không đoán theo thứ tự, xem "Hai số" bên dưới | `tl-ui-feedback serve <overlay> http://localhost:<dev>` |
| `/tl-ui-feedback serve --cmd "<lệnh dev server>" <cổng>` | site chưa chạy; `<cổng>` là cổng dev server mà lệnh sẽ mở | `tl-ui-feedback serve --cmd "<lệnh>" http://localhost:<cổng>` |
| `/tl-ui-feedback serve ...` (dạng khác) | chuyển nguyên văn cho CLI | `tl-ui-feedback serve ...` |
| `/tl-ui-feedback` không đối số | dùng lại site đang chạy nếu có, nếu không thì hỏi site | `tl-ui-feedback serve --list` |

**Hai đối số:** nếu có một đối số không phải số (URL, thư mục, file) thì đó là site, số còn lại là cổng overlay, thứ tự nào cũng được.

**Hai số (`8082 8081`):** thứ tự không nói được số nào là dev server, nên kiểm tra thực tế: cổng nào đang có tiến trình lắng nghe mà KHÔNG nằm trong `tl-ui-feedback serve --list` thì là dev server (PowerShell: `Get-NetTCPConnection -LocalPort N -State Listen -ErrorAction SilentlyContinue`; sh: `curl -s -o /dev/null http://localhost:N`). Cổng còn lại (đang trống) là cổng overlay.
- Đúng một cổng đang chạy: chốt như trên.
- Cả hai đang chạy hoặc cả hai trống: không đoán, hỏi người dùng cổng nào là dev server.
- Cổng đang trống không chắc dùng được thì cứ chạy; nếu `serve` báo cổng bận thì báo lại, đừng đổi sang cổng khác.
- Luôn nói rõ cách hiểu trong dòng báo ở bước 4, ví dụ "dev server localhost:8082, mở http://localhost:8081", để người dùng sửa nếu hiểu ngược.

Các bước:
1. Chạy `tl-ui-feedback serve --list` để biết cổng nào đã bị chiếm. Chỉ dùng lại một serve do CHÍNH phiên này đã mở (bạn đã thấy dòng `đang phục vụ` của nó), rồi bỏ qua bước 2. Serve của phiên hoặc agent khác thì không đụng và không dừng: mở serve mới ở cổng tự chọn, vì mỗi agent gắn với đúng một site.
2. Chạy lệnh `serve` **ở chế độ nền** (Bash hoặc PowerShell với `run_in_background`), vì lệnh chạy mãi tới khi bị dừng. Không thêm `--no-open`: trình duyệt tự mở trang cho người dùng. Với `--cmd`, Expo/Vite có thể mất vài chục giây để lên; mặc định chờ 60 giây, thêm `--wait 180` nếu app nặng.
3. Đọc đầu ra của tiến trình nền tới khi thấy dòng `đang phục vụ ... tại http://localhost:<p>`. Nếu thấy dòng bắt đầu bằng `lỗi:` (cổng bận, lệnh thoát sớm, quá hạn chờ, upstream không phải loopback) thì báo nguyên nhân và dừng; đừng đoán sang lệnh khác.
4. Nói với người dùng đúng một dòng: địa chỉ `http://localhost:<p>` (cổng overlay, KHÔNG phải cổng dev server) và "bấm nút Feedback, click phần tử, gõ ghi chú". Khi agent xin quyền chạy lệnh, thẻ hiện ngay trong khung chat để người dùng bấm Cho phép/Từ chối, không cần mã. Lệnh rủi ro (rm, git push...) vẫn hỏi ở terminal. Với hai số thì nêu rõ số nào là dev server.
5. Đặt `ORIGIN = http://localhost:<p>` (cổng overlay mà lệnh in ra, không phải cổng dev server). Vào ngay vòng lặp bên dưới và luôn truyền `origin: ORIGIN` cho cả `tl_ui_feedback_poll` lẫn `tl_ui_feedback_reply`. Dừng khi người dùng bảo dừng, rồi chạy `tl-ui-feedback serve --stop <p>` (việc này cũng tắt dev server do `--cmd` chạy).

Lệnh `tl-ui-feedback` có thể chưa nằm trong PATH của phiên này: nếu báo không tìm thấy, dùng đường dẫn đầy đủ `~/.ui-feedback-bridge/bin/ui-feedback` (Windows: `%USERPROFILE%/.ui-feedback-bridge/bin/ui-feedback.cmd`).

Ví dụ: `/tl-ui-feedback 8081` chạy `tl-ui-feedback serve http://localhost:8081`. `/tl-ui-feedback 8082 8081` khi chỉ có Expo ở 8082 chạy `tl-ui-feedback serve 8081 http://localhost:8082` (mở http://localhost:8081); gõ `/tl-ui-feedback 8081 8082` cũng ra đúng như vậy. `/tl-ui-feedback serve --cmd "npx expo start --web --port 8081" 8081` chạy `tl-ui-feedback serve --cmd "npx expo start --web --port 8081" http://localhost:8081`.

Các dạng site khác của `serve`: thư mục hoặc file tĩnh `tl-ui-feedback serve ./dist` (thêm `--spa` cho SPA có route); xem đang chạy gì `tl-ui-feedback serve --list`.
Lưu ý: trang qua `serve` có origin là cổng của `serve`, nên đăng nhập và localStorage tách khỏi trang ở cổng gốc. Chỉ dùng cho site của chính người dùng (upstream mặc định chỉ nhận localhost).

## Vòng lặp
Tên tool MCP: `tl_ui_feedback_poll` và `tl_ui_feedback_reply`. Cài qua plugin thì tên đầy đủ có tiền tố (`mcp__plugin_tl-ui-feedback_tl-ui-feedback__tl_ui_feedback_poll`); cài bằng `install` thì là `mcp__tl-ui-feedback__...`. Chọn tool nào trong danh sách tool của bạn có đuôi đúng tên đó; không có tool MCP thì dùng CLI `tl-ui-feedback poll`/`reply`.

1. Gọi tool MCP `tl_ui_feedback_poll` với `origin: ORIGIN` (hoặc chạy nền `tl-ui-feedback poll --origin ORIGIN`). Không có `origin` thì bạn nhận tin của MỌI site và cướp tin của agent khác. Khi có site chạy qua `serve`, thiếu `origin` sẽ báo lỗi. Poll tự xác nhận (ack) đã nhận để trang hiện "Agent đã đọc"; nếu bạn không xử lý hoặc trả lời trong 60 giây, tin sẽ bị giao lại. Nó chờ im lặng đến khi có phản hồi; hết thời gian thì gọi lại, hàng đợi không mất tin.
2. Với mỗi phản hồi: mở các file trong mục `source`. Dòng đầu là nơi phần tử được dựng; dòng kế là nơi component cha dùng nó, thường là chỗ cần sửa. Nếu không có file nguồn, dùng `components`, `selector`, `text`.
3. Sửa tối thiểu đúng điều người dùng ghi chú. Không đổi thứ khác.
4. Ngay sau khi nhận tin, gọi `tl_ui_feedback_reply` (không `id`, kèm `origin`) một câu ngắn kiểu "đang xem desktop.tsx" để người dùng thấy agent đã bắt đầu. Người dùng theo dõi trực tiếp trong khung chat trên trang: nên gọi `tl_ui_feedback_reply` (không `id`, kèm `origin: ORIGIN`) để báo tiến độ ngắn khi việc kéo dài, rồi trả lời cuối kèm `id`. CLI tương đương: `tl-ui-feedback reply "<đã sửa gì>" --id <id>` hoặc `--origin ORIGIN`. Tin tiến độ không có `origin` sẽ hiện ở mọi site.
5. Quay lại bước 1. Chỉ dừng khi người dùng bảo dừng.

## Lưu ý
- Phản hồi có thể là tin nhắn tự do (không có phần tử/file nguồn): làm theo nội dung ghi chú.
- File nguồn đến từ dev server (React fiber + Metro symbolicate); bản production không có.
- Phần tử sinh trong vòng lặp trỏ tới dòng `map`; dùng `text`/`testID` để tìm đúng mục.
- Không đưa nội dung ghi chú hay text trang ra ngoài máy.
