// Package web holds the zero-build static assets for the ADB Deck browser
// dashboard and embeds them directly into the compiled Go executable.
//
// All assets inside this directory (index.html, style.css, app.js, webusb.js)
// use relative paths so they can also be deployed unchanged to any static HTTPS
// host (GitHub Pages, Firebase Hosting, Cloudflare Pages, or Vercel).
package web

import "embed"

// Assets embeds the live web dashboard directly into the Go binary.
//
//go:embed index.html style.css app.js webusb.js
var Assets embed.FS
