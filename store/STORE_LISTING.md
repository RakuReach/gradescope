# Chrome Web Store submission

Build with `scripts/package.sh`, then upload `dist/gradescope-plus-<version>.zip`.

## Store listing
- **Name:** Gradescope+
- **Category:** Education (Tools)
- **Language:** English
- **Summary:** See what's due next on every Gradescope course card, plus your grade as a meme.
- **Description:**

  See what's due next without opening every course.

  On your Gradescope dashboard, each student course card shows:
  • Next assignment: a countdown to the earliest assignment you haven't submitted
  • A meme picture that changes with your grade in the course
  • A "See Grade" button with your total percentage and a score breakdown for each assignment

  The grade is total points earned divided by total points possible across graded assignments. It is an estimate, not your official course grade.

  All data stays in your browser. Nothing is sent anywhere.

  Not affiliated with Gradescope or Turnitin.

- **Store icon:** store/store-icon-128.png (upload on the Store listing tab; the zip icon is not used here)
- **Screenshots (1280×800):** in this order
  1. store/images/screenshot-1-countdown.png
  2. store/images/screenshot-2-grade.png
  3. store/images/screenshot-3-tiers.png
- **Small promo tile (440×280):** store/images/promo-small-440x280.png
- **Marquee promo tile (1400×560):** store/images/promo-marquee-1400x560.png

All images use fictional courses. Edit the pages in `store/src/` and run `scripts/render-store-images.sh` to regenerate them.

## Privacy practices tab
- **Single purpose:** Show upcoming assignment deadlines and grade estimates on the Gradescope course dashboard.
- **storage justification:** Caches each course's assignment list for 10 minutes so the dashboard loads quickly without refetching every course.
- **Host permission justification (gradescope.com):** Reads the user's own Gradescope course pages to get due dates, submission status and scores. It runs only on gradescope.com.
- **Remote code:** No, I am not using remote code.
- **Data usage:** Tick only "Website content". Grades are read but never leave the device. Certify all three disclosures (not sold, not used for unrelated purposes, not used for creditworthiness).
- **Privacy policy URL:** https://github.com/RakuReach/gradescope/blob/main/store/PRIVACY.md
