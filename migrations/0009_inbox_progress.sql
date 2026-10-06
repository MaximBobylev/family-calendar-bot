-- tech-debt #5: повтор апдейта после сбоя не повторяет уже сделанные шаги (STT, «🎙 …», LLM).
--   transcript  — распознанный (и исправленный) текст голосового;
--   stage       — докуда дошла обработка голосового: NULL | 'transcribed' | 'heard' («🎙 …» отправлено);
--   intent_json — разобранный LLM интент вместе с текстом, по которому разбирали: {"text": …, "intent": …}.
-- Сбрасываются, когда апдейт обработан (status = 'done'); у упавших живут до ретеншна inbox (30 дней).
ALTER TABLE inbox ADD COLUMN transcript TEXT;
ALTER TABLE inbox ADD COLUMN stage TEXT;
ALTER TABLE inbox ADD COLUMN intent_json TEXT;
