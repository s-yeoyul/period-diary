# Calendar — 웹앱

날짜별 체크 기록, 두 사람 실시간 공유, 일정 알림이 있는 캘린더 웹앱.
기록은 기기에 저장되고, 공유 데이터는 기기에서 암호화한 뒤 서버에 올라갑니다.

## 설정
- `firebase-config.js` — Firebase 웹 앱 설정
- `notify-config.js` — 알림 서버 주소와 공개키 (비워 두면 알림 기능 숨김)

## 로컬 실행
```bash
python3 -m http.server 8765
```
브라우저에서 `http://localhost:8765`

## 배포
`main`에 push하면 GitHub Actions가 GitHub Pages로 배포합니다.
