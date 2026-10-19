// Terminal compatibility stays here: the SDK owns validation, uploads, waits,
// history and stream lifecycle; this adapter preserves established CLI output.
export function cliClient(client) {
  const message = value => {
    const { streaming, replyToMessageId, ...rest } = value;
    return { ...rest, inProgress: streaming, replyTo: replyToMessageId };
  };
  const request = (options = {}) => {
    const { signal, ...input } = options;
    return { input, options: { signal } };
  };
  const history = async input => {
    const args = request(input);
    const { hasMore, ...result } = await client.history(args.input, args.options);
    return { ...result, messages: result.messages.map(message) };
  };
  const watch = async (input = {}, all = false) => {
    const { onMessage, onReady, onCursor, ...native } = input;
    const args = request(native);
    const subscription = await client.watch({ ...args.input, ...(all ? { all: true } : {}) }, args.options);
    try {
      for await (const event of subscription) {
        if (native.signal?.aborted) break;
        if (event.type === 'message') await onMessage?.(message(event.message));
        else if (event.type === 'ready') { const { type, ...ready } = event; await onReady?.(ready); }
        else if (event.type === 'cursor') { const { type, ...cursor } = event; await onCursor?.(cursor); }
      }
      await subscription.done;
    } finally { await subscription.cancel(); }
  };
  const methods = {
    primary: input => client.primary(request(input).options),
    listDots: input => client.listDots(request(input).options),
    history, historyPages: history,
    send(input = {}) {
      const { files, waitSeconds, ...native } = input;
      const args = request(native);
      return client.send({ ...args.input, ...(files ? { attachments: files } : {}), ...(waitSeconds > 0 ? { wait: true, waitTimeoutMs: waitSeconds * 1000 } : {}) }, args.options).catch(error => {
        if (waitSeconds > 0 && error.code === 'ABORTED' && error.receipt) return { ...error.receipt, wait: { status: 'interrupted', error: 'INTERRUPTED', messages: [] } };
        throw error;
      }).then(result => ({ ...result, ...(result.wait ? { wait: { ...result.wait, messages: result.wait.messages.map(message) } } : {}) }));
    },
    watch: input => watch(input), watchAll: input => watch(input, true),
    search: input => { const args = request(input); return client.search(args.input, args.options).then(result => ({ ...result, matches: result.matches.map(message) })); },
    upload(input = {}) { const { file, ...native } = input; const args = request(native); return client.upload({ ...args.input, path: file }, args.options).then(result => {
      if (!result.attachment) return result;
      const { fileId, mimeType, sizeBytes, ...rest } = result.attachment;
      return { ...result, attachment: { ...rest, file_id: fileId, mime_type: mimeType, size_bytes: sizeBytes } };
    }); },
    download: input => { const args = request(input); return client.download(args.input, args.options).then(({ output, ...result }) => result); },
    artifacts: input => { const args = request(input); return client.artifacts(args.input, args.options); },
  };
  return new Proxy(methods, { get: (value, key) => Object.hasOwn(value, key) ? value[key] : client.advanced[key] });
}
