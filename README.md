# Citation Cards for Zotero

Click an in-text citation in Zotero's PDF reader to see the cited paper's title, authors, abstract and links, in a card styled like Google Scholar's PDF Reader. Cards come from Google Scholar when you're signed in to Google inside Zotero, and from [OpenAlex](https://openalex.org) otherwise.

Requires Zotero 10 or higher.

## Install

1. Download `citation-cards.xpi` from the [latest release](https://github.com/shamus-li/zotero-citation-cards/releases/latest).
2. In Zotero, open **Tools → Plugins**, click the gear icon, choose **Install Plugin From File…** and select the file.

## Sign in to Google Scholar

1. Open **Zotero → Settings** (**Edit → Settings** on Windows and Linux) and choose **Citation Cards**.
2. Click **Sign in to Google Scholar** and sign in in the window that opens.
3. Close the window. The page should say **Signed in as** followed by your email.

## Notes

- If Google Scholar asks for a CAPTCHA, cards use OpenAlex for 30 minutes. Click **Open Google Scholar** on the card to solve it sooner.
- Without a key, OpenAlex allows about 100 searches a day. A free key from [openalex.org/settings/api](https://openalex.org/settings/api) raises it to 1,000.

## Reporting problems

In Zotero, choose **Help → Debug Output Logging → Enable**, reproduce the problem, then choose **Help → Debug Output Logging → Submit Debug Output**. [Open an issue](https://github.com/shamus-li/zotero-citation-cards/issues) with the Debug ID Zotero shows.

