# Hitline (GitHub Pages version)
Free hosting: a GitHub Action builds the data every 2 hours and publishes the site to GitHub Pages.
Needs a PUBLIC repo (Pages on private repos is a paid feature).
Setup: add secret NHL_ODDS_KEY (Settings > Secrets and variables > Actions), then Settings > Pages > Source: GitHub Actions,
then Actions tab > Build data and deploy > Run workflow. Diagnostics: your-site/debug.json
