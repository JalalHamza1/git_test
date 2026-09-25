# Tasks — home version (Synology NAS + iPhone)

Your task app running on your own NAS. It's free, your data stays at home, and it
works offline: changes save on the device instantly and sync when the NAS is reachable.

- **PocketBase** (a small database server) runs on the NAS in Container Manager.
- **Tailscale** connects your iPhone and computer to the NAS securely from anywhere,
  with HTTPS, without opening ports on your router.
- On the iPhone the app is added to the Home Screen and opens like a normal app.

Setup takes about 20–30 minutes. You need:

- Your Synology NAS (DSM 7.2 or later) and a computer on your home network.
- A free Tailscale account (https://tailscale.com, sign in with Google, Microsoft or Apple).
- Your iPhone.

---

## 1. Copy the app to the NAS

1. Open DSM in your browser and start **File Station**.
2. If there is no `docker` shared folder yet, create one: **Control Panel → Shared Folder → Create**, name it `docker`.
3. Inside `docker`, create a folder called `tasks`.
4. Unzip `home-app.zip` on your computer and upload **everything inside it** to `docker/tasks`.
   You should end up with `docker/tasks/Dockerfile`, `docker/tasks/docker-compose.yml`
   and the folders `pb_hooks`, `pb_migrations` and `pb_public`.

## 2. Start it in Container Manager

1. Open **Package Center**, search for **Container Manager** and install it (skip if it's already installed).
   If your model doesn't offer Container Manager, see [No Container Manager?](#no-container-manager) below.
2. Open **Container Manager → Project → Create**.
3. Project name: `tasks`. Path: choose `docker/tasks`. It detects the existing `docker-compose.yml`; keep it.
4. Click **Next**, skip the Web Station page, then **Done**. The first build downloads PocketBase and takes a minute or two.
5. Check it's running: **Container → tasks → Log** should show `Server started at http://0.0.0.0:8090`.

Your tasks are stored in `docker/tasks/pb_data`.

## 3. Connect the NAS to Tailscale (this gives you the HTTPS address)

1. In **Package Center**, install **Tailscale**, open it and sign in with your Tailscale account.
2. On your computer, open the Tailscale admin console (https://login.tailscale.com/admin/dns) and turn on:
   - **MagicDNS**
   - **HTTPS Certificates**
3. Turn on SSH for a moment: **Control Panel → Terminal & SNMP → Enable SSH service**.
4. On your computer, open a terminal (Mac: Terminal; Windows: PowerShell) and run, using your DSM admin user and your NAS's IP address:

   ```
   ssh your-admin-user@192.168.1.X
   sudo /var/packages/Tailscale/target/bin/tailscale serve --bg http://127.0.0.1:8090
   ```

   It prints your app address, something like `https://your-nas.tail1234.ts.net`. Write it down.
   This setting survives restarts.
5. Turn SSH off again in **Control Panel → Terminal & SNMP**.

## 4. Create your account (on your computer)

1. Install Tailscale on your computer (https://tailscale.com/download) and sign in with the same account.
2. Open your app address (`https://your-nas.….ts.net`) in the browser.
3. It shows **Create your account**. Enter your email and a password (at least 8 characters).

Only this first account can be created from the app; after that, sign-up is closed.

## 5. Set up your iPhone

1. Install **Tailscale** from the App Store, sign in with the same account and switch it on.
   In the Tailscale app, turn on **VPN On Demand** so it's always connected.
2. Open **Safari** and go to your app address. Sign in.
3. Tap the **Share** button → **Add to Home Screen** → **Add**.
4. Open **Tasks** from your Home Screen. From now on it opens instantly, even without signal.

## 6. See tasks in your iPhone Calendar (with reminders)

1. In the app, open **Settings** (gear icon) and tap **Copy** next to the calendar link.
2. On the iPhone: **Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → Add Subscribed Calendar**.
3. Paste the link, tap **Next**, turn off **Remove Alerts**, then **Save**.

Tasks with a date appear in Calendar. Timed tasks alert 15 minutes before; all-day tasks alert at 9:00.
iPhone refreshes subscribed calendars every 15 minutes or so. The link is private. If you
ever share it by mistake, use **Reset** in Settings and add the calendar again.

---

## Backups

Your data is the folder `docker/tasks/pb_data`. Include it in **Hyper Backup**, or
take Snapshot Replication snapshots of the `docker` shared folder.

## Updating

- **New app version:** replace the files in `docker/tasks/pb_public`, then in
  Container Manager open the `tasks` project and choose **Action → Build** (or stop and start it).
  Phones pick up the new version the next time the app opens.
- **New PocketBase version:** change `PB_VERSION` in the `Dockerfile`, then **Build** the project again.

## Admin dashboard (optional)

PocketBase has a dashboard at `https://your-nas.….ts.net/_/` for browsing data, adding
another person or making backups. To create the dashboard login, open
**Container Manager → Container → tasks → Terminal → Create → sh** and run:

```
/pb/pocketbase superuser upsert you@example.com a-long-password --dir=/pb/pb_data
```

## No Container Manager?

Some budget models can't run containers. PocketBase is a single program, so it can run directly:

1. Download the PocketBase release for your NAS's processor from
   https://github.com/pocketbase/pocketbase/releases (version 0.40.4). Use `linux_arm64` for
   most ARM models and `linux_amd64` for Intel/AMD models. Check your processor under
   **Control Panel → Info Center**.
2. Unzip it and upload the `pocketbase` file into `docker/tasks` (next to `pb_public`).
3. **Control Panel → Task Scheduler → Create → Triggered Task → User-defined script**,
   User: `root`, Event: **Boot-up**. Script:

   ```
   cd /volume1/docker/tasks && chmod +x pocketbase && ./pocketbase serve --http=127.0.0.1:8090
   ```

4. Select the task and click **Run** (it also starts after every restart). Then continue with step 3 (Tailscale).

## Troubleshooting

- **"Can't reach your NAS"**: make sure Tailscale is switched on (on the iPhone and on the NAS).
  The app still works offline; changes sync when it reconnects.
- **The address doesn't open**: in the Tailscale admin console, check that **HTTPS Certificates** is on.
  Then run the `tailscale serve` command again.
- **Container won't build**: the NAS needs internet access to download PocketBase from GitHub the first time.
- **Status says "Sync problem"**: open Settings in the app and tap **Sync now**. If it persists,
  check the container log in Container Manager.
