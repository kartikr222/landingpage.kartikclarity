from pathlib import Path
import re

path = Path("index.html")
text = path.read_text(encoding="utf-8")

SOCIALS = [
    ("Instagram", "Instagram", "instagram-link", "https://www.instagram.com/kartik.clarity/"),
    ("Twitter X", "X", "x-link", "https://x.com/kartikclarity"),
    ("YouTube", "YouTube", "youtube-link", "https://youtube.com/@kartikclarity"),
    ("Reddit", "Reddit", "reddit-link", "https://www.reddit.com/u/KartikClarity/s/kIG9GDOa7p"),
    ("Discord", "Discord", "discord-link", "https://discord.gg/Mp6T782e"),
]

for label, title, cls, url in SOCIALS:
    pattern = re.compile(
        rf'<span class="social-icon social-placeholder" aria-label="{re.escape(label)}" title="{re.escape(title)}">(.*?)</span>',
        re.S,
    )
    replacement = (
        f'<a class="social-icon {cls}" href="{url}" aria-label="{label}" '
        f'title="{title}" target="_blank" rel="noopener noreferrer">\\1</a>'
    )
    text = pattern.sub(replacement, text)

path.write_text(text, encoding="utf-8")
print("Available social placeholders linked.")
