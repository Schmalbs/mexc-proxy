# MEXC CORS Proxy

Deploy this to Railway in 3 steps — no credit card, free tier.

## Deploy to Railway

1. Go to https://railway.app and sign up with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Push this folder to a GitHub repo first (see below), then select it

## Push to GitHub first

1. Go to https://github.com/new — create a new repo called `mexc-proxy`
2. Open terminal and run:

```bash
cd mexc-proxy
git init
git add .
git commit -m "initial"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/mexc-proxy.git
git push -u origin main
```

3. Back on Railway → New Project → Deploy from GitHub → select `mexc-proxy`
4. Railway will auto-detect Node.js and deploy it
5. Click your deployment → **Settings** → **Domains** → **Generate Domain**
6. Copy the URL (e.g. `https://mexc-proxy-production.up.railway.app`)

## Update your trading app

Open `mexc-trader.html` and change line:
```js
const PROXY = '';
```
to:
```js
const PROXY = 'https://YOUR-RAILWAY-URL.up.railway.app';
```

That's it — the app will now work from any device, anywhere.
