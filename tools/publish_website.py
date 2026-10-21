"""Make PRO TAG a real website with built-in multiplayer: friends just type the address.

    Double-click publish-website.bat   (or: python tools/publish_website.py)

FIRST TIME (about 5 minutes, all free):
  1. GitHub keeps a copy of your game. The script opens GitHub's "new repository" page with
     everything filled in - you click "Create repository". Then it uploads the game
     (your browser asks you to sign in to GitHub the first time).
  2. Render runs it as a website. The script opens Render's one-click deploy page - you sign
     in with GitHub and click "Deploy". A couple of minutes later your game is live at an
     address like https://pro-tag.onrender.com - that is the link you give your friends.

AFTER THAT: run it again whenever you change the game. It uploads the changes and Render
updates the website automatically.

Nothing here stores passwords: GitHub sign-in is handled by Git's own credential manager.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_FILE = os.path.join(ROOT, "tools", "publish.json")
DEFAULT_NAME = "pro-tag"


def say(text=""):
    print(text, flush=True)


def ask(prompt, default=None, interactive=True):
    if not interactive:
        return default
    suffix = f" [{default}]" if default else ""
    try:
        answer = input(f"  {prompt}{suffix}: ").strip()
    except EOFError:
        answer = ""
    return answer or default


def git(*args, check=True, capture=False):
    res = subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=capture)
    if check and res.returncode != 0:
        raise subprocess.CalledProcessError(res.returncode, ["git", *args], res.stdout, res.stderr)
    return res


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def clean_repo_name(name):
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", (name or "").strip()).strip("-.")
    return name or DEFAULT_NAME


def clean_username(name):
    name = (name or "").strip().lstrip("@")
    m = re.match(r"(?:https?://github\.com/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))", name)
    return m.group(1) if m else ""


def github_new_repo_url(name):
    q = urllib.parse.urlencode({"name": name, "description": "PRO TAG - 3D parkour tag game with online multiplayer", "visibility": "public"})
    return f"https://github.com/new?{q}"


def render_deploy_url(repo_web_url):
    return "https://render.com/deploy?" + urllib.parse.urlencode({"repo": repo_web_url})


def open_url(url, browser):
    say(f"     {url}")
    if browser:
        webbrowser.open(url)


def ensure_repo(username):
    """Create the local git repository the first time and make sure commits have an author."""
    if not os.path.isdir(os.path.join(ROOT, ".git")):
        git("init", "-q")
        git("checkout", "-q", "-b", "main", check=False)
    # Publish under the GitHub username + GitHub's private "noreply" address so a personal or
    # school e-mail address never ends up in the public history.
    if username:
        git("config", "user.name", username)
        git("config", "user.email", f"{username}@users.noreply.github.com")
    elif git("config", "user.email", check=False, capture=True).stdout.strip() == "":
        git("config", "user.name", "PRO TAG")
        git("config", "user.email", "pro-tag@users.noreply.github.com")


def commit_all():
    git("add", "-A")
    if git("diff", "--cached", "--quiet", check=False).returncode == 0:
        return False
    git("commit", "-q", "-m", "Update PRO TAG website")
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description="Publish PRO TAG as a website (GitHub + Render).")
    ap.add_argument("--remote", help="git remote URL to push to (skips the GitHub questions)")
    ap.add_argument("--no-browser", action="store_true", help="print links instead of opening them")
    ap.add_argument("--yes", action="store_true", help="never ask questions (use saved/default answers)")
    ap.add_argument("--user", help="GitHub username (otherwise you are asked)")
    ap.add_argument("--name", help="repository / website name (default pro-tag)")
    args = ap.parse_args(argv)
    interactive = not args.yes
    browser = not args.no_browser

    say("\n  ==========================================================")
    say("   PRO TAG  -  make your game a website friends can open")
    say("  ==========================================================\n")
    if not shutil.which("git"):
        say("  Git is needed for this. Install it from https://git-scm.com/download/win and run this again.")
        return 1

    state = load_state()
    first_time = not state.get("remote")
    if args.user:
        state["user"] = clean_username(args.user)

    if args.remote:
        state["remote"] = args.remote
        state.setdefault("web", args.remote.removesuffix(".git"))
    elif first_time:
        say("  STEP 1 of 2  -  GitHub (stores your game, free)")
        say("  -----------------------------------------------")
        say("  No GitHub account yet? Make one at https://github.com/signup first.\n")
        user = state.get("user") or clean_username(ask("Your GitHub username", interactive=interactive))
        if not user:
            say("  A GitHub username is needed. Run this again when you have one.")
            return 1
        name = clean_repo_name(args.name or ask("Name for your game's website", DEFAULT_NAME, interactive))
        say("\n  Opening GitHub's 'Create a new repository' page with everything filled in.")
        say("  Just scroll down and click the green  Create repository  button.")
        open_url(github_new_repo_url(name), browser)
        ask("Press Enter here once you have clicked 'Create repository'", "", interactive)
        state.update({"user": user, "name": name, "remote": f"https://github.com/{user}/{name}.git", "web": f"https://github.com/{user}/{name}"})

    ensure_repo(state.get("user"))
    changed = commit_all()
    remotes = git("remote", check=False, capture=True).stdout.split()
    git("remote", "set-url" if "origin" in remotes else "add", "origin", state["remote"])
    say("\n  Uploading your game to GitHub" + (" (a browser window may ask you to sign in)..." if first_time else "..."))
    push = git("push", "-u", "origin", "HEAD:main", check=False)
    if push.returncode != 0:
        say("\n  The upload didn't work. Usually this means one of these:")
        say("   - the repository wasn't created yet (finish step 1 in the browser), or")
        say("   - the username or name was mistyped (delete tools/publish.json and run again), or")
        say("   - the GitHub sign-in window was closed.")
        save_state({k: v for k, v in state.items() if k != "remote"} if first_time else state)
        return 1
    save_state(state)
    say("  Uploaded." if changed or first_time else "  Already up to date.")

    if not first_time and not state.get("deployed"):
        # never re-open the deploy page automatically: that could create a second website
        say("\n  Render updates your website automatically within 1-3 minutes.")
        say("  (Haven't finished the Render step yet? Open this link once:)")
        open_url(render_deploy_url(state.get("web", "")), False)
        site = ask("Paste your website address to remember it (or press Enter)", "", interactive)
        if site:
            state["site"] = site.strip().rstrip("/")
            state["deployed"] = True
            save_state(state)
    elif first_time:
        say("\n  STEP 2 of 2  -  Render (runs your website, free)")
        say("  ------------------------------------------------")
        say("  Opening Render's one-click deploy page for your game:")
        open_url(render_deploy_url(state.get("web", "")), browser)
        say("   1. Sign in with GitHub (the same account) if asked.")
        say("   2. If Render asks for access to your repositories, allow it for this one.")
        say("   3. Click  Deploy Blueprint  (or Apply / Create). Leave every setting as it is.")
        say("   4. Wait 2-3 minutes until it says  Live  - then click the address at the top,")
        say("      something like  https://pro-tag.onrender.com")
        site = ask("Paste your website address here when it's live (or just press Enter to skip)", "", interactive)
        if site:
            state["site"] = site.strip().rstrip("/")
            state["deployed"] = True
            save_state(state)
    else:
        say("\n  Render is updating your website now - it takes 1-3 minutes.")

    say("\n  ==========================================================")
    if state.get("site"):
        say(f"   Your game:  {state['site']}")
        say("   Give that address to your friends. Everyone opens it, clicks")
        say("   Play -> Create lobby, and shares the invite link or lobby code.")
    else:
        say("   When Render shows 'Live', its address is your game's website.")
        say("   Give that address to your friends and play together!")
    say("   (Free websites nap after 15 minutes alone; the first visit then takes ~1 minute.)")
    say("   To update the website later, just run publish-website.bat again.")
    say("  ==========================================================\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
