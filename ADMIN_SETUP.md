# 관리자 기능 켜기 (한 번만, 약 15분)

홈페이지 맨 아래 **Admin** 을 누르면 관리자 로그인 화면이 나옵니다. 관리자는 **GitHub 계정으로 로그인**해서 활동·수상·연구과제·구성원·논문을 홈페이지 안에서 바로 추가·수정·삭제하고, 다른 관리자를 초대할 수 있습니다.

- **관리자 (P.I. 등)** = 이 저장소(`kim2384/hibe-lab`)에 쓰기 권한이 있는 GitHub 계정. 모든 메뉴를 편집하고 관리자·학생을 추가합니다. 홈페이지 구조·디자인은 저장소의 `index.html`을 직접(또는 클로드에게 부탁해) 고칩니다.
- **학생 연구원** = 관리 화면 '관리자' 탭의 학생 명단에 넣은 GitHub 계정. 저장소 권한 없이 **활동·수상·논문**만 추가·수정·삭제할 수 있습니다. 이 제한은 Worker가 서버에서 막기 때문에 다른 방법으로 우회할 수 없습니다.
- **자동 작성** = 관리 화면 맨 위에 상장 사진, 논문 PDF, 연구개발계획서, 행사 사진 등을 올리면 어느 메뉴에 무엇을 쓸지 초안을 만들어 줍니다. 초안은 저장 전에 꼭 확인합니다.
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
4. Worker 주소를 적어 둡니다 (예: `https://hibe-admin.hyde1207.workers.dev`).

## 3. GitHub OAuth App 만들기
1. https://github.com/settings/developers > **OAuth Apps > New OAuth App**
   - Application name: `hibe lab admin`
   - Homepage URL: 1번의 홈페이지 주소
   - Authorization callback URL: `https://hibe-admin.hyde1207.workers.dev/callback` (2번 주소 + `/callback`)
2. 만든 뒤 **Client ID** 를 복사하고, **Generate a new client secret** 으로 비밀 키를 만들어 복사합니다.

## 4. Worker에 값 넣기
Cloudflare의 Worker 화면 **Settings > Variables and Secrets > Add** 에서:

| 이름 | 종류 | 값 |
|---|---|---|
| `GITHUB_CLIENT_ID` | Text | 3번의 Client ID |
| `GITHUB_CLIENT_SECRET` | **Secret** | 3번의 client secret |
| `SITE_ORIGINS` | Text | `https://kim2384.github.io` (경로 없이 주소 앞부분만. 학교 도메인을 연결하면 쉼표로 추가: `https://kim2384.github.io,https://hibe.cau.ac.kr`) |
| `GITHUB_REPO` | Text | `kim2384/hibe-lab` |
| `GITHUB_WRITE_TOKEN` | **Secret** | 학생 연구원 저장용 토큰 (아래 4-1) |
| `ANTHROPIC_API_KEY` | **Secret** | 자동 작성(파일 → 초안)과 연구개발계획서 요약을 쓸 때. https://console.anthropic.com 에서 발급 |

### 4-1. 학생 연구원 저장용 토큰 만들기
학생은 저장소 권한이 없으므로, 학생이 저장하면 Worker가 이 토큰으로 대신 저장합니다. 이 토큰은 이 저장소의 파일 읽기·쓰기만 할 수 있습니다.
1. https://github.com/settings/personal-access-tokens/new (Fine-grained token)
2. Token name: `hibe-admin-worker`, Expiration: 가능한 길게(만료되면 새로 만들어 다시 넣으면 됩니다)
3. Repository access: **Only select repositories** → `kim2384/hibe-lab`
4. Permissions > Repository permissions > **Contents: Read and write** (다른 권한은 건드리지 않음)
5. Generate token → 나온 값을 Worker의 `GITHUB_WRITE_TOKEN`(Secret)에 넣습니다.

비밀 키(client secret, API 키, 토큰)는 이 화면에만 넣고 다른 곳(채팅, 메일, 저장소)에 붙여넣지 마세요.

## 5. 홈페이지에 Worker 주소 넣기
`index.html` 에서 아래 줄에 2번의 Worker 주소를 넣습니다. 공개돼도 괜찮은 값이라 클로드에게 알려 주셔도 됩니다.

```js
const GH_AUTH = "https://hibe-admin.hyde1207.workers.dev";
```

## 6. 첫 로그인과 관리자 추가
1. 홈페이지 맨 아래 **Admin > GitHub로 로그인**. 처음 한 번은 GitHub가 권한 승인을 묻습니다.
2. **관리자** 탭에서
   - 모든 메뉴를 편집할 관리자: 위쪽 '관리자 초대'에 GitHub 아이디를 넣습니다. 초대받은 분이 GitHub 메일이나 알림에서 수락해야 합니다.
   - 학생 연구원: 아래쪽 '학생 추가'에 GitHub 아이디를 넣습니다. 수락 절차 없이 바로 로그인할 수 있습니다.
3. GitHub 계정은 github.com에서 무료로 만들 수 있습니다.

## 참고
- 로그인 정보는 그 브라우저 탭에만 보관되고, 탭을 닫으면 사라집니다.
- GitHub 승인 범위는 `public_repo` (공개 저장소 쓰기)입니다. 관리자 기능은 이 저장소 하나에만 씁니다.
- Worker가 멈춰도 홈페이지는 그대로 보이고, 관리자 로그인만 잠시 안 됩니다.
- 기본 내용은 `index.html` 안에 있고, 관리 화면에서 한 번이라도 저장한 메뉴는 `content/<메뉴>.json` 이 우선합니다.
