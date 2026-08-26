# 하루한칸

Google 계정으로 로그인하고 하루 한 줄을 남기는 수업용 풀스택 예제입니다.

```text
Vercel 정적 프론트엔드 ─┬─ Firebase Authentication (Google 로그인)
                         └─ Render Node API ─ Render PostgreSQL
```

Render API는 프론트엔드가 전송한 Firebase ID 토큰을 검증하고, 토큰의 `uid`를 기준으로 각 사용자의 기록을 분리합니다. PostgreSQL 접속 정보는 브라우저에 전달되지 않습니다.

## 로컬 프론트엔드

```powershell
python -m http.server 4173
```

`http://localhost:4173`에서 접속합니다. 실제 API를 로컬에서 실행하려면 [config.js](./config.js)의 주소와 서버 환경변수를 설정해야 합니다. `먼저 둘러보기`는 서버 없이 동작합니다.

## Render 환경변수

- `DATABASE_URL`: Blueprint가 Render PostgreSQL 내부 주소를 자동 연결
- `FIREBASE_PROJECT_ID`: Firebase 설정의 `projectId`
- `CORS_ORIGINS`: Vercel 주소(여러 개면 쉼표로 구분)

## 배포

저장소 루트의 `render.yaml`은 무료 Web Service와 무료 PostgreSQL을 함께 만드는 Blueprint입니다. Render에서 이 저장소를 Blueprint로 연결하고 입력을 요구하는 환경변수 두 개를 채웁니다.

Vercel에는 저장소 루트를 정적 사이트로 배포합니다. Render API 주소가 정해지면 [config.js](./config.js)의 `HARU_API_URL`을 해당 `https://...onrender.com` 주소로 변경합니다.

## API

- `GET /health`: 서버와 DB 상태
- `GET /api/entries`: 로그인 사용자의 기록 목록
- `POST /api/entries`: 기록 생성
- `DELETE /api/entries/:id`: 자신의 기록 삭제

`/api/entries` 요청은 모두 `Authorization: Bearer <Firebase ID token>` 헤더가 필요합니다.

## 테스트

```powershell
cd server
npm ci
npm test
```

Render 무료 PostgreSQL은 생성 후 30일에 만료되며 무료 인스턴스에는 백업이 없습니다.
