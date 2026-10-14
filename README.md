# Before We Invite Someone In

A private questionnaire for two people, Matt and Louise. Each of you answers on your own phone. When you submit, your phone locks (encrypts) your answers with a password you choose before anything is sent. The database only ever stores the locked version. Nobody can read your answers without your password: not your partner, and not whoever runs the database or this site.

To read the answers, you sit together and each type your own password on one phone.

There are no accounts and no sign-in. The site is a single page hosted free on GitHub Pages, and the locked answers are stored in a free Supabase database.

## Setup (about 15 minutes, once)

### 1. Create the database

1. Go to [supabase.com](https://supabase.com) and sign up (free).
2. Click **New project**. Pick any name (for example `bwisi`), set a database password (you won't need it again for this), choose a region near you, and click **Create new project**. Wait a minute or two while it sets up.
3. In the left sidebar, click **SQL Editor**, then **New query**.
4. Open the file `supabase/schema.sql` from this repository, copy all of it, paste it into the editor, and click **Run**. You should see "Success. No rows returned."

### 2. Connect the page to the database

1. In Supabase, open **Project Settings** (gear icon) → **API Keys** (on some projects it's called **API**).
2. Copy the **Project URL**. It looks like `https://abcdefghijklmnop.supabase.co`.
3. Copy the **anon public** key (a long string starting with `eyJ`). Newer projects may show a **publishable** key starting with `sb_publishable_` instead; that works too. Do not use the `service_role` or `secret` key.
4. In this repository, open `config.js` and paste them between the quotes:

   ```js
   window.BWISI_CONFIG = {
     supabaseUrl: "https://abcdefghijklmnop.supabase.co",
     supabaseAnonKey: "eyJ..."
   };
   ```

5. Save and commit the change. Both values are safe to publish. The key only allows what `schema.sql` permits, and every answer is already locked before it's sent.

### 3. Put the site online with GitHub Pages

1. Push this repository to GitHub. It can be private if you have a paid plan, otherwise it needs to be public. The answers are never in the repository.
2. On GitHub, open the repository → **Settings** → **Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose branch **main** and folder **/ (root)**, then click **Save**.
4. After a minute or two, the page is live at:

   `https://<your-github-username>.github.io/<repository-name>/`

   GitHub shows the exact link at the top of the Pages settings once it's ready.

If you ever see "This page isn't connected yet", `config.js` still has empty values.

## How to use it

1. Each of you opens the link on your own phone and taps your name.
2. Answer Stage 1. Your draft saves on your phone as you go, so you can stop and come back.
3. When you're done, tap **Submit my answers** and choose a password. Type it twice. Don't share it. If you forget it, your answers can only be rebuilt from the draft on your phone.
4. The home screen shows when your partner has saved. You can still change your answers with **Edit my answers** and your password.
5. When you've both saved, sit together and tap **Read Stage 1 together** on one phone. Each of you types your own password.
6. At the end, each of you says where you stand, on your own phone. Stage 2 (planning) only opens if you both say you're a genuine yes.

## For the curious

- Encryption: PBKDF2 (SHA-256, 200,000 rounds) turns your password into a key, then AES-GCM 256 locks the answers. All of it happens in the browser.
- Each saved row is found by a fingerprint of your name, the stage, and your password. The public can't read or search by that fingerprint, and all changes go through small database functions that need it. See the comments in `supabase/schema.sql`.
- Stored in plain text, on purpose: who has saved, when, whether a stage has been read together, and each person's yes / not sure / no at the end of Stage 1. That's what lets each phone show progress without a password.
- If someone saves with a new password, that becomes a new version. The page always uses the newest one and offers to delete older versions after you open it.
- The page only talks to your Supabase project and Google Fonts. No analytics. If you use a custom Supabase domain, add it to `connect-src` in the security line at the top of `index.html`.

## Tests

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
node tests/run.js
```

The tests run two simulated phones against a fake, in-memory copy of the database and print PASS or FAIL for each check. Set `BWISI_SHOTS=some-folder` to also save light and dark screenshots of each screen.
