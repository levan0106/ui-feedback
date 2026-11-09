# Store listing — copy/paste cho Chrome Web Store và Edge Add-ons

Ngôn ngữ chính: **English** (người dùng rộng). Bản Tiếng Việt ở cuối nếu muốn thêm locale.

## Name
UI Feedback Bridge

## Summary (≤ 132 ký tự, khớp `description` trong manifest)
Point at a wrong UI element on your localhost dev page and send it to your coding agent. Runs only on localhost / 127.0.0.1.

## Category
Developer Tools

## Detailed description
UI Feedback Bridge lets you point at a wrong element on your local dev app and send it straight to your AI coding agent (Claude Code, Codex, any MCP client) — no screenshots, no copy-pasting selectors.

How it works
1. Open your dev app on http://localhost:<port>. A "Feedback" button appears at the bottom right.
2. Click it, click the element that looks wrong, type a note.
3. The agent receives your note plus the element's selector, computed styles, component chain and — for React apps — the source file and line. It fixes the code and replies; the answer shows up in the chat panel on your page.

Requirements
- This extension is the browser half. It talks only to a small local bridge you run yourself (Node >= 20): see the setup guide at <REPO_URL>.
- Without the local bridge running, the button simply shows "cannot reach bridge".

Privacy
- Runs only on localhost, 127.0.0.1 and https://localhost. It does nothing on any other website.
- Sends data only to the bridge on 127.0.0.1 on your own machine. No servers of ours, no analytics, no tracking.

Open source: <REPO_URL>

## Single purpose (ô "Single purpose description" của Chrome)
Let a developer select a UI element on their own localhost development page and send it, with a note, to a coding agent through a local bridge on 127.0.0.1.

## Giải trình quyền (ô "Permission justification")
- **Permissions**: none requested (không khai báo `permissions`).
- **Host access / content script matches** (`http://localhost/*`, `http://127.0.0.1/*`, `https://localhost/*`):
  The content script injects the feedback overlay (button, element picker, chat panel) into the developer's own dev pages. It is restricted to loopback addresses; it never runs on public websites.
- **world: MAIN**: the overlay reads React/React Native Web fiber data attached to DOM nodes (component chain and source file:line), which is only visible from the page's own JavaScript context.
- **Remote code**: No. All code ships inside the package. The extension makes network requests only to `http://127.0.0.1:47831` (the user's own local bridge).

## Data usage disclosure (form "Privacy practices")
Tick: **Website content** (the selected element's selector/styles/text and the user's note) — used only for the extension's single purpose, sent only to the user's own machine (127.0.0.1).
Không tick: personally identifiable info, health, financial, authentication, location, web history, user activity (keystrokes/clicks ngoài thao tác chọn phần tử), …
Certify cả 3: không bán dữ liệu, không dùng cho mục đích không liên quan, không dùng để xét tín dụng.

## Privacy policy URL
`<REPO_URL>/blob/main/store/PRIVACY.md` (cần URL công khai; xem PUBLISH.md).

## Assets cần chuẩn bị
| Asset | Yêu cầu | Nguồn |
|---|---|---|
| Icon 128×128 | PNG | `extension/icons/icon128.png` (đã có) |
| Screenshot | 1280×800 (hoặc 640×400), 1–5 ảnh | chụp lại từ `tests/e2e-extension/*.png` hoặc app thật, resize 1280×800 |
| Small promo tile (Chrome) | 440×280, tuỳ chọn nhưng nên có | tự thiết kế |
| Edge logo | 300×300 | resize icon128 (hoặc xuất lại từ `scripts/gen-icons.mjs`) |

## Bản Tiếng Việt (locale vi)
Chỉ vào phần UI sai trên trang dev localhost và gửi thẳng cho agent code (Claude Code, Codex, MCP client) — không cần chụp hình hay chép selector. Agent nhận ghi chú + selector + style + chuỗi component + file:dòng nguồn, sửa code và trả lời ngay trong khung chat trên trang. Extension chỉ chạy trên localhost / 127.0.0.1 và chỉ nói chuyện với bridge trên máy bạn.
