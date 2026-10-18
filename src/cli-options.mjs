// Shared by basic parsing and help discovery. Values retain the parser's
// original vocabulary so repeated attachment flags keep their behavior.
export const basicCommandOptions = Object.freeze(Object.fromEntries([
  'auth status', 'auth login', 'auth logout', 'auth refresh', 'status', 'dots', 'history', 'watch', 'send',
].map(name => {
  const flags = { '--auth-file': 'value', '--json': 'boolean' };
  if (['history', 'watch', 'send'].includes(name)) flags['--room'] = 'value';
  if (name === 'history') Object.assign(flags, { '--limit': 'value', '--before': 'value', '--after': 'value', '--pages': 'value', '--task': 'value', '--around': 'value' });
  if (name === 'watch') Object.assign(flags, { '--interval': 'value', '--from-start': 'boolean', '--duration': 'value', '--cursor-file': 'value', '--all': 'boolean' });
  if (name === 'send') Object.assign(flags, { '--file': 'value', '--stdin': 'boolean', '--key': 'value', '--attach': 'repeat', '--attachment-id': 'repeat', '--reply-to': 'value', '--wait': 'value', '--task': 'value', '--page': 'value', '--page-thread': 'value', '--metadata-file': 'value', '--annotations-file': 'value' });
  return [name, Object.freeze(flags)];
})));
