# 하루한칸

Google 계정으로 로그인하고 하루 한 줄을 남기는 수업용 웹 앱입니다.

```text
Vercel 정적 프런트엔드
  ├─ Firebase Authentication: Google 로그인
  └─ Render Node API
       └─ Neon PostgreSQL: 사용자별 기록 저장
```

프런트엔드는 Firebase ID 토큰을 API로 보냅니다. Render API는 토큰을 검증하고 Firebase `uid`를 기준으로 기록을 분리합니다. PostgreSQL 접속 정보는 브라우저에 전달되지 않습니다.

## 배포 주소

- 프런트엔드: https://my-ochre-gamma.vercel.app
- API: https://haru-one-line-api.onrender.com
- 상태 확인: https://haru-one-line-api.onrender.com/health

## 로컬 실행

프런트엔드:

```powershell
python -m http.server 4173
```

브라우저에서 `http://localhost:4173`으로 접속합니다. `config.js`의 API 주소를 로컬 서버로 바꾸지 않아도 배포 API를 사용할 수 있습니다. 서버 없이 화면만 확인하려면 `먼저 둘러보기`를 선택합니다.

API:

```powershell
cd server
npm ci
npm start
```

## Render 환경변수

- `DATABASE_URL`: Neon PostgreSQL 연결 문자열
- `FIREBASE_PROJECT_ID`: Firebase 프로젝트 ID
- `CORS_ORIGINS`: 허용할 Vercel 주소

환경변수의 실제 값은 Git에 저장하지 않습니다.

## API

- `GET /health`: 서버와 DB 상태
- `GET /api/entries`: 로그인 사용자의 기록 목록
- `POST /api/entries`: 기록 생성
- `DELETE /api/entries/:id`: 자신의 기록 삭제

`/api/entries` 요청에는 `Authorization: Bearer <Firebase ID token>` 헤더가 필요합니다.

## 테스트

```powershell
cd server
npm test
```

Neon 무료 DB는 사용하지 않을 때 자동으로 절전되며, 처음 요청은 잠시 느릴 수 있습니다. Render 무료 Web Service도 절전 후 첫 요청에서 깨어나는 시간이 필요할 수 있습니다.
