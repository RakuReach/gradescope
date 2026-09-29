# Gradescope+

Chrome extension that adds to each **Student Courses** card on the Gradescope dashboard:

- **Next assignment:** countdown to the earliest unsubmitted assignment that is not yet past its regular due date.
- A "Mr. Incredible becoming uncanny" meme picked from your grade (total points earned / possible across graded assignments).
- A **See Grade** button that opens a per-assignment score breakdown.

Course pages are fetched in the background and cached for 10 minutes. Countdowns refresh every minute.

<p align="center">
  <img src="store/images/screenshot-1-countdown.png" alt="Next-assignment countdown on a course card" width="600"><br>
  <img src="store/images/screenshot-2-grade.png" alt="Grade meme and See Grade breakdown" width="600"><br>
  <img src="store/images/screenshot-3-tiers.png" alt="Grade meme tiers" width="600">
</p>

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Disable the old grade/next-assignment extension so the two don't both draw on the cards.

## Publish

Bump `version` in `manifest.json`, run `scripts/package.sh`, and upload the zip from `dist/` in the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole). Listing text and privacy answers are in `store/`.

## Layout

| Path | Contents |
|------|----------|
| `manifest.json`, `content.js`, `content.css` | The extension |
| `images/` | Grade meme tiers |
| `icons/` | Extension icons |
| `store/` | Web Store listing text, privacy policy, store icon |
| `store/src/`, `store/images/` | HTML sources and rendered store screenshots and promo tiles |
| `scripts/package.sh` | Builds the upload zip into `dist/` |
| `scripts/render-store-images.sh` | Renders `store/src/` into `store/images/` with headless Chrome |

## Grade tiers

Edit `GRADE_TIERS` in `content.js`. Images are `images/tier1.png` (best) to `images/tier13.png` (worst).

| Grade | Tier | Image |
|-------|------|-------|
| ≥ 99% | tier1 | <img src="images/tier1.png" alt="tier1" height="48"> |
| ≥ 97% | tier2 | <img src="images/tier2.png" alt="tier2" height="48"> |
| ≥ 95% | tier3 | <img src="images/tier3.png" alt="tier3" height="48"> |
| ≥ 93% | tier4 | <img src="images/tier4.png" alt="tier4" height="48"> |
| ≥ 90% | tier5 | <img src="images/tier5.png" alt="tier5" height="48"> |
| ≥ 85% | tier6 | <img src="images/tier6.png" alt="tier6" height="48"> |
| ≥ 80% | tier7 | <img src="images/tier7.png" alt="tier7" height="48"> |
| ≥ 75% | tier8 | <img src="images/tier8.png" alt="tier8" height="48"> |
| ≥ 70% | tier9 | <img src="images/tier9.png" alt="tier9" height="48"> |
| ≥ 65% | tier10 | <img src="images/tier10.png" alt="tier10" height="48"> |
| ≥ 60% | tier11 | <img src="images/tier11.png" alt="tier11" height="48"> |
| ≥ 50% | tier12 | <img src="images/tier12.png" alt="tier12" height="48"> |
| < 50% | tier13 | <img src="images/tier13.png" alt="tier13" height="48"> |

Courses with no graded work show tier4 (the neutral face).
