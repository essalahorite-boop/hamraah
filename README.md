# Hamraah ہمراہ — Carpool board

Carpool site for Mansehra, Abbottabad, Haripur, Islamabad and Rawalpindi, in Urdu and English.
Drivers post rides, passengers post seat requests, and the site matches them.

Node.js + Express. Database: Turso online, or a local SQLite file when running on your laptop.

---

## 1. Run it on your laptop

1. Install **Node.js LTS** from https://nodejs.org
2. Open a terminal in this folder (in File Explorer, type `cmd` in the address bar and press Enter).
3. Run:
   ```
   npm install
   npm start
   ```
4. Open http://localhost:3000

On your laptop the posts are saved in `data/hamraah.db`. No Turso account is needed for this.

---

## 2. Put it online for free (Turso + Render + cron-job.org)

### Step A: Create the database on Turso
1. Go to https://turso.tech and sign up with GitHub.
2. Create a database (any name, e.g. `hamraah`). Pick the region closest to Pakistan (e.g. Mumbai or Frankfurt).
3. On the database page, copy the **Database URL**. It looks like `libsql://hamraah-yourname.turso.io`.
4. Click **Create Token** and copy the token.

Keep both somewhere safe. **Never put the token on GitHub.**

### Step B: Upload the code to GitHub
1. On github.com, click **New repository**, name it `hamraah` and click **Create**.
2. Click **"uploading an existing file"** and drag in: `server.js`, `package.json`, `README.md`, `.gitignore` and the `public` folder.
3. **Don't** upload `node_modules` or `data`.
4. Click **Commit changes**.

### Step C: Run it on Render
1. Go to https://render.com and sign up with GitHub.
2. Click **New → Web Service** and choose your `hamraah` repo.
3. Fill in:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Under **Environment Variables**, add:

   | Key | Value |
   |---|---|
   | `TURSO_DATABASE_URL` | the URL from Step A |
   | `TURSO_AUTH_TOKEN` | the token from Step A |
   | `ADMIN_KEY` | a long password only you know |

5. Click **Create Web Service**. After a couple of minutes you'll get a link like `https://hamraah.onrender.com`.

### Step D: Keep it awake (free)
Render's free servers sleep after about 15 minutes with no visitors, and the next visitor waits about a minute.
1. Go to https://cron-job.org and sign up.
2. Create a cronjob with URL `https://YOUR-SITE.onrender.com/api/rides`, running every **10 minutes**.

### Step E: Test, then share
Open the link on your phone using mobile data, post a test ride, then delete it. If that works, share the link in the group.

Free plans and limits change, so check each site's current pricing.

---

## 3. Moderation (your ADMIN_KEY)

A post is hidden automatically after 3 different people report it. To see hidden posts:

```
curl https://YOUR-SITE.onrender.com/api/admin/hidden -H "x-edit-token: YOUR_ADMIN_KEY"
```

To delete a post (use `rides` or `requests`):
```
curl -X DELETE https://YOUR-SITE.onrender.com/api/rides/POST_ID -H "x-edit-token: YOUR_ADMIN_KEY"
```

To restore a post that was reported unfairly:
```
curl -X PATCH https://YOUR-SITE.onrender.com/api/rides/POST_ID -H "x-edit-token: YOUR_ADMIN_KEY" -H "Content-Type: application/json" -d "{\"hidden\":false}"
```

---

## 4. Updating the site
Upload the changed files to GitHub again, and Render redeploys automatically. Your posts stay safe in Turso.

---

## How it works

- **No login.** When someone posts, the server gives their browser a secret edit key. Only that browser can edit or delete the post.
- **Posting limits:** 5 posts per hour per browser and 100 per hour per connection. The connection limit is loose because Pakistani mobile networks share IP addresses.
- **Reports:** 3 reports from different browsers hide a post.
- **Caching:** the server keeps the post list in memory and only reads the database after something changes, so the free Turso limits go a long way.
- **Clean-up:** posts older than 60 days are deleted automatically.
- **Security headers** (CSP, no framing, nosniff) are set on every response.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/rides`, `/api/requests` | Visible posts from the last 60 days |
| POST | `/api/rides`, `/api/requests` | Returns `{ id, token }`; send `x-client-id` |
| PATCH | `/api/:kind/:id` | `{ status }`, `{ seats }`; needs `x-edit-token` |
| DELETE | `/api/:kind/:id` | Needs `x-edit-token` |
| POST | `/api/:kind/:id/report` | Needs `x-client-id` |
| GET | `/api/admin/hidden` | Needs `ADMIN_KEY` as `x-edit-token` |

Errors come back as `{ "code": "phone" }` and similar; the front end shows them in Urdu or English.
