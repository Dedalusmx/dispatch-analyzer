# Dispatch Load Analyzer

Dry Van dispatch decision-support and training tool. Helps dispatchers evaluate incoming broker loads during live phone calls.

**This is a planning tool only.** It is not a substitute for ELD systems, HOS compliance systems, or company dispatch software.

## Deploy to Vercel (recommended)

### Step 1: Push to GitHub

```bash
# In the project directory
git init
git add .
git commit -m "Dispatch Load Analyzer v2"

# Create a repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/dispatch-load-analyzer.git
git branch -M main
git push -u origin main
```

### Step 2: Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **"Add New Project"**
3. Import your `dispatch-load-analyzer` repository
4. Vercel auto-detects Next.js — click **Deploy**
5. Done. You'll get a public URL like `dispatch-load-analyzer.vercel.app`

Every push to `main` will auto-deploy.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Tests

```bash
npm test
```

132 tests covering the HOS planning engine, risk analysis, decision scoring, negotiation strategy, daily mileage, and reload risk.

## Architecture

- `app/analyzer.tsx` — Full React client component (UI + inlined calculation engine)
- `lib/calculations.js` — Standalone calculation engine (CommonJS, for testing)
- `tests/calculations.test.js` — Comprehensive test suite

## Key features

- **Truck profiles** with stored HOS data (localStorage)
- **HOS planning engine** — chronological trip simulation with deadhead, 30-min breaks, 10-hr rest, cycle tracking
- **Negotiation strategy** — suggested counter, target, and minimum rates based on configurable RPM thresholds
- **Daily mileage target** — warns when loads fall below 500 mi/day (configurable)
- **Reload risk** — configurable state avoidance with warning/strong/block severity
- **Training mode** — decide before seeing the analysis
- **What-If** — test alternate scenarios without changing the load
