# 관리자 기능 켜기 (한 번만, 약 15분)

홈페이지 맨 아래 **Admin** 을 누르면 관리자 로그인 화면이 나옵니다. 관리자는 **GitHub 계정으로 로그인**해서 활동·수상·연구과제·구성원·논문을 홈페이지 안에서 바로 추가·수정·삭제하고, 다른 관리자를 초대할 수 있습니다.

- 관리자 = 이 저장소(`kim2384/hibe-lab`)에 쓰기 권한이 있는 GitHub 계정
- 저장하면 내용은 `content/<메뉴>.json`, 사진은 `images/uploads/` 에 커밋되고 **1~2분 뒤** 홈페이지에 반영됩니다.
- 모든 수정이 저장소 기록(커밋)으로 남으므로, 잘못 고쳐도 GitHub에서 이전 버전으로 되돌릴 수 있습니다.

로그인을 중계하는 작은 서버(Cloudflare Worker, 무료) 하나가 필요합니다. GitHub 로그인에는 비밀 키가 필요한데, 홈페이지 파일에는 비밀 키를 넣을 수 없기 때문입니다.

## 1. 홈페이지 공개 (GitHub Pages)
1. 저장소 **Settings > Pages** 에서 *Source* 를 **Deploy from a branch**, 브랜치 **main**, 폴더 **/(root)** 로 저장합니다.
2. 잠시 뒤 나오는 주소를 적어 둡니다 (예: `https://kim2384.github.io/hibe-lab/`).

## 2. Cloudflare Worker 만들기
1. https://dash.cloudflare.com 에서 가입합니다. 연구실 공용 이메일로 만들면 담당 학생이 바뀌어도 계정이 남습니다.
2. **Workers & Pages > Create > Create Worker**, 이름을 `hibe-admin` 으로 하고 **Deploy**.
3. **Edit code** 를 눌러 기존 코드를 지우고 이 저장소의 `worker/worker.js` 내용을 통째로 붙여넣은 뒤 **Deploy**.
4. Worker 주소를 적어 둡니다 (예: `https://hibe-admin.아이디.workers.dev`).

## 3. GitHub OAuth App 만들기
1. https://github.com/settings/developers > **OAuth Apps > New OAuth App**
   - Application name: `hibe lab admin`
   - Homepage URL: 1번의 홈페이지 주소
   - Authorization callback URL: `https://hibe-admin.아이디.workers.dev/callback` (2번 주소 + `/callback`)
2. 만든 뒤 **Client ID** 를 복사하고, **Generate a new client secret** 으로 비밀 키를 만들어 복사합니다.

## 4. Worker에 값 넣기
Cloudflare의 Worker 화면 **Settings > Variables and Secrets > Add** 에서:

| 이름 | 종류 | 값 |
|---|---|---|
| `GITHUB_CLIENT_ID` | Text | 3번의 Client ID |
| `GITHUB_CLIENT_SECRET` | **Secret** | 3번의 client secret |
| `SITE_ORIGINS` | Text | `https://kim2384.github.io` (경로 없이 주소 앞부분만. 학교 도메인을 연결하면 쉼표로 추가: `https://kim2384.github.io,https://hibe.cau.ac.kr`) |
| `GITHUB_REPO` | Text | `kim2384/hibe-lab` |
| `ANTHROPIC_API_KEY` | **Secret** | (선택) 연구개발계획서 PDF로 과제 자동 작성을 쓸 때만 |

비밀 키(client secret, API 키)는 이 화면에만 넣고 다른 곳(채팅, 메일, 저장소)에 붙여넣지 마세요.

## 5. 홈페이지에 Worker 주소 넣기
`index.html` 에서 아래 줄에 2번의 Worker 주소를 넣습니다. 공개돼도 괜찮은 값이라 클로드에게 알려 주셔도 됩니다.

```js
const GH_AUTH = "https://hibe-admin.아이디.workers.dev";
```

## 6. 첫 로그인과 관리자 추가
1. 홈페이지 맨 아래 **Admin > GitHub로 로그인**. 처음 한 번은 GitHub가 권한 승인을 묻습니다.
2. **관리자** 탭에서 추가할 분의 GitHub 아이디로 초대합니다 (초대·삭제는 저장소 소유자만 가능).
3. 초대받은 분이 GitHub 메일이나 알림에서 수락하면 바로 로그인할 수 있습니다. GitHub 계정은 github.com에서 무료로 만들 수 있습니다.

## 참고
- 로그인 정보는 그 브라우저 탭에만 보관되고, 탭을 닫으면 사라집니다.
- GitHub 승인 범위는 `public_repo` (공개 저장소 쓰기)입니다. 관리자 기능은 이 저장소 하나에만 씁니다.
- Worker가 멈춰도 홈페이지는 그대로 보이고, 관리자 로그인만 잠시 안 됩니다.
- 기본 내용은 `index.html` 안에 있고, 관리 화면에서 한 번이라도 저장한 메뉴는 `content/<메뉴>.json` 이 우선합니다.
