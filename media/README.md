# Screenshots

`accounts.png` and `usage.png` are the two images the README links, from the `HEAD` raw URL so
they render on the VS Code Marketplace page as well as on GitHub. Relative paths do not work on
the Marketplace.

They are not mockups. Both are rendered from the shipped `webview/` — the same stylesheets and the
same `app.js` render path the extension uses — driven by one fake state object, then captured with
headless Chrome at a 2x device scale and cropped to the content height.

**Every account in them is fictional.** `quota.pool.dev@gmail.com` and `quota.pool.ci@gmail.com`
do not exist, the avatars are generated initials rather than photos, and the token counts and
quota readings are invented. Nothing here comes from a real signed-in account, which is the point:
these ship in a public README.

Re-render them after any change to the panel so the README does not drift from the product.
