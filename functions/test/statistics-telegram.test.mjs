import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { Api, InputFile } = require('grammy');
process.env.BOT_TOKEN = '123:test-token';
const { editStatisticsMessage, sendStatisticsMessage } = require('../lib/bot.js');

test('a chart is sent or edited as a photo below the MarkdownV2 report', async (context) => {
    const sendPhoto = context.mock.method(Api.prototype, 'sendPhoto', async () => ({ message_id: 41 }));
    const editMedia = context.mock.method(Api.prototype, 'editMessageMedia', async () => true);
    const text = '*' + 'а'.repeat(1023) + '*\\.';
    const report = { text, photo: Uint8Array.of(1, 2, 3) };
    const caption = { caption: text, parse_mode: 'MarkdownV2', show_caption_above_media: true };

    assert.equal(await sendStatisticsMessage(7, report), 41);
    await editStatisticsMessage(7, 40, report);

    const [chatId, file, options] = sendPhoto.mock.calls[0].arguments;
    assert.equal(chatId, 7);
    assert.ok(file instanceof InputFile);
    assert.equal(file.filename, 'publications.png');
    assert.deepEqual(options, caption);

    const [editedChatId, messageId, media] = editMedia.mock.calls[0].arguments;
    assert.equal(editedChatId, 7);
    assert.equal(messageId, 40);
    assert.ok(media.media instanceof InputFile);
    assert.deepEqual(media, { type: 'photo', media: media.media, ...caption });
});

test('reports exceeding the caption limit still send and edit as full text', async (context) => {
    const sendText = context.mock.method(Api.prototype, 'sendMessage', async () => ({ message_id: 41 }));
    const editText = context.mock.method(Api.prototype, 'editMessageText', async () => true);
    const sendPhoto = context.mock.method(Api.prototype, 'sendPhoto', async () => ({ message_id: 42 }));
    const editMedia = context.mock.method(Api.prototype, 'editMessageMedia', async () => true);
    const report = { text: 'а'.repeat(1025), photo: Uint8Array.of(1, 2, 3) };
    const options = { parse_mode: 'MarkdownV2' };

    assert.equal(await sendStatisticsMessage(7, report), 41);
    await editStatisticsMessage(7, 40, report);

    assert.deepEqual(sendText.mock.calls[0].arguments, [7, report.text, options]);
    assert.deepEqual(editText.mock.calls[0].arguments, [7, 40, report.text, options]);
    assert.equal(sendPhoto.mock.callCount(), 0);
    assert.equal(editMedia.mock.callCount(), 0);
});
