# lake-gate landing (static, no build step)

- Open `index.html` directly or serve the folder: `python3 -m http.server 4191`.
- Before publishing, replace `GITHUB_URL` in index.html and `GOATCOUNTER_CODE` in site.js. Until the code is set, no analytics script loads, and it never loads on localhost.
- Design-partner CTA: a mailto to lake.research1@gmail.com with a prefilled subject and questions. To use a form instead, swap the `#partner-cta` href for a free Tally form URL.
- Visual tokens and assets are reused from /workspace/lake/plan-gate/landing (Inter, teal #0E7C7B, ink #073F4B, mist, wave-disc logo, lake scene).
- Screenshots: `screenshots/` (1440 and 390 wide, no horizontal overflow, no console errors).
