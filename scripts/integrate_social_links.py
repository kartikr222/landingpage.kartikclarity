from pathlib import Path
import re

path = Path('index.html')
text = path.read_text(encoding='utf-8')

# Existing YouTube placeholders in the MVP header/footer.
yt_url = 'https://youtube.com/@kartikclarity'
reddit_url = 'https://www.reddit.com/user/Hungry-Lie-2220/'

# Convert YouTube social placeholders into real external links.
text = re.sub(
    r'<span class="social-icon social-placeholder" aria-label="YouTube" title="YouTube">(.*?)</span>',
    lambda m: f'<a class="social-icon youtube-link" href="{yt_url}" aria-label="YouTube" title="YouTube" target="_blank" rel="noopener noreferrer">{m.group(1)}</a>',
    text,
    flags=re.S,
)

# Convert Reddit social placeholders into real external links.
text = re.sub(
    r'<span class="social-icon social-placeholder" aria-label="Reddit" title="Reddit">(.*?)</span>',
    lambda m: f'<a class="social-icon reddit-link" href="{reddit_url}" aria-label="Reddit" title="Reddit" target="_blank" rel="noopener noreferrer">{m.group(1)}</a>',
    text,
    flags=re.S,
)

path.write_text(text, encoding='utf-8')
print('YouTube and Reddit social links integrated.')
