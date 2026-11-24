# hibe lab website

Homepage of the Hyper-Intelligent Built Environment Laboratory (hibe lab), Chung-Ang University.

- `index.html`: the site (single page, hash routing). Content lives in the `SITE` and `KO` objects near the top of the script.
- `data/citations.json`: Google Scholar citation counts. Written once a day by the workflow below; the page reads it on load and falls back to a built-in OpenAlex snapshot if it is missing.
- `scripts/sync_scholar.py` + `.github/workflows/scholar-sync.yml`: daily (03:00 KST) Scholar sync through SerpApi. Needs the repository secret `SERPAPI_KEY`. Run it by hand from Actions → "Sync Google Scholar citations" → Run workflow.

Status: design draft. Member and project photos are placeholders, and Activities posts are saved only in the visitor's browser until the content-management tool is set up.
