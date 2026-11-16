# The Composer in Claude in Chrome

Work only in the tab received as the Surface, with the `mcp__claude-in-chrome__*`
tools and the rules of the `chrome-browser` skill. Use `javascript_tool` to inspect
the Composer and `computer` for screenshots, clicks, typing and keys.

## Find the Composer

Use the examples below only when inspection confirms a single `[role=textbox]`,
which is the conversation's Composer:

```js
document.querySelectorAll('[role=textbox]').length
```

With several fields, use a specific selector observed in the conversation (or
`read_page`); do not pick the first result by assumption. Check for a draft before
editing:

```js
document.querySelector('[role=textbox]').innerText
```

## Insert the text

Click the Composer with `computer`, at coordinates confirmed by screenshot. If "New
chat" opens, close it with `Escape`, check that nothing was sent and find the
Composer again.

`Enter` sends. So never pass `\n` inside the text of the `type` action: type one line
at a time and, between lines, use the `key` action with `shift+Enter`. For a blank
paragraph, use `shift+Enter` twice.

Then check the content and the formatting:

```js
(()=>{const e=document.querySelector('[role=textbox]');return e.innerText+' ## fmt='+e.querySelectorAll('b,strong,i,em').length})()
```

Compare with the approved message and check `fmt=0`. Blank lines may show as
`\n\n\n` in `innerText`; check the paragraph by screenshot too.

## Redo the inserted text

Only to redo text you yourself inserted in this run, clear the Composer with:

```js
(()=>{const e=document.querySelector('[role=textbox]');e.focus();document.execCommand('selectAll');document.execCommand('delete');return e.innerText.trim().length})()
```

It must return `0` before you insert the same approved text again. If you cannot
check or clear the Composer, return **Blocked**.

## Send

At the **Send once** step of `gchat:gchat-send`, with the Composer focused, use a
single `key` action with `Enter`. Do not repeat the key if the tool returns an error
or a timeout; go on to **Check and return the result**.

Go back to the **Insert and check the text** step of `gchat:gchat-send` to finish
checking the edit before sending. In the check afterwards, `innerText` helps to see
the empty Composer, but the screenshot must show the newly sent message in the right
conversation.
