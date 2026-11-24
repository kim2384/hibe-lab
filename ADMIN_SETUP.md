# 관리자 기능 켜기 (한 번만)

홈페이지 맨 아래 **Admin** 을 누르면 관리자 로그인 화면이 나옵니다. 로그인한 관리자는 활동·수상·연구과제·구성원·논문을 홈페이지 안에서 바로 추가·수정·삭제하고, 다른 관리자를 추가할 수 있습니다. 클로드 계정이나 GitHub 계정은 필요 없습니다.

내용과 사진은 무료 서비스인 Supabase에 저장됩니다. 아래 순서대로 한 번만 설정하면 됩니다 (약 15분).

## 1. Supabase 프로젝트 만들기
1. https://supabase.com 에서 가입하고 **New project** 를 만듭니다 (지역: Northeast Asia (Seoul)).
2. 왼쪽 **SQL Editor** 에서 이 저장소의 `supabase/schema.sql` 내용을 통째로 붙여넣고 **Run**.
   - 관리자 명단, 내용 저장 표, 변경 이력, 사진 저장소가 만들어지고 `myk127@cau.ac.kr` 이 첫 관리자로 등록됩니다.
3. **Authentication > Sign In / Providers > Email** 에서 *Confirm email* 이 켜져 있는지 확인합니다 (켜져 있어야 남의 이메일로 계정을 못 만듭니다).
4. **Authentication > URL Configuration** 의 *Site URL* 에 홈페이지 주소를 넣습니다 (예: https://kim2384.github.io/hibe-lab/).

## 2. 홈페이지에 연결
**Settings > API** 에 있는 *Project URL* 과 *anon public* 키를 `index.html` 의 아래 두 줄에 넣습니다. 이 두 값은 공개돼도 괜찮은 값입니다 (권한은 1번의 규칙이 지킵니다). 클로드에게 알려 주셔도 됩니다.

```js
const SUPABASE_URL = "https://xxxx.supabase.co";
const SUPABASE_ANON_KEY = "eyJ...";
```

## 3. 첫 로그인
홈페이지 > Admin > **처음이신가요? 계정 만들기** 에서 `myk127@cau.ac.kr` 과 비밀번호를 정하고, 받은 확인 메일의 링크를 누른 뒤 로그인합니다.
다른 관리자는 **관리자** 탭에서 이메일을 추가하면, 그분이 같은 방법으로 비밀번호를 만들어 로그인합니다.

처음 저장하는 구역부터 Supabase에 저장된 내용이 홈페이지에 보이고, 아직 저장하지 않은 구역은 지금 내용 그대로 보입니다. 저장할 때마다 이전 내용은 `site_content_history` 표에 자동으로 남습니다.

## 4. (선택) 연구개발계획서 자동 요약
연구과제 > 새로 추가 에서 계획서 PDF를 올리면 과제명·기간·기관·연구비·역할·설명을 자동으로 채웁니다. Claude API를 쓰므로 별도 키가 필요합니다.
1. https://platform.claude.com 에서 API 키를 만듭니다 (사용량만큼 과금).
2. Supabase **Edge Functions > Secrets** 에 `ANTHROPIC_API_KEY` 로 저장합니다.
3. **Edge Functions > Deploy a new function > Via Editor** 에서 이름을 `summarize-plan` 으로 하고 `supabase/functions/summarize-plan/index.ts` 내용을 붙여넣어 배포합니다.
