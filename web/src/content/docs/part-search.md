---
title: Part search
description: Search DigiKey and Mouser from GoatCAD. Both need a free API key from the distributor.
order: 6
---

**Part search** in the activity bar searches DigiKey and Mouser for real parts: prices,
stock, datasheets and CAD model links. Each distributor needs a free API key, which takes
a few minutes to get. Set them up in **Settings ▸ Distributor APIs**; **Get a key from…**
opens the right page.

## DigiKey

1. Sign in on [DigiKey's developer portal](https://developer.digikey.com/) and add a
   **Production** app. A Sandbox app uses a different server and will not work.
2. Tick **Product Information V4** in the product list. It starts with nothing ticked.
3. Leave **OAuth Callback** empty. GoatCAD does not use it.
4. Paste the app's Client ID and Client Secret into GoatCAD and click **Save key**.

## Mouser

1. Sign in on [Mouser's API hub](https://www.mouser.com/api-hub/).
2. Request a key for the **Search API**. Mouser sends it by email.
3. Paste the key into GoatCAD and click **Save key**.

## After setup

Each distributor shows a status: Connected, Not connected, Not checked or Not working.
**Test connection** checks the key again.

Keys come with a small daily quota, around 1,000 requests. The settings page shows how
much is used; it resets at midnight UTC. Filters apply when you click **Apply filters**
rather than on every checkbox, so they do not spend requests one at a time.

Keys are encrypted with your system keyring. On a Linux system without one (no
libsecret or KWallet), GoatCAD cannot encrypt a key and does not save it.
