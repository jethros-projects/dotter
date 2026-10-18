import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';
import { DotLibrary } from './library.mjs';
import { writePrivate } from './store.mjs';
import { withOperationLock } from './operation-lock.mjs';
import { validateStorageUploadHeaders } from './transport.mjs';
import { readLibraryUploadSource, prepareVerifiedUploadRange } from './library-upload-source.mjs';

// Native Library upload, not messaging upload. Audited in app-initial m6r,
// y6r, x6r, D6r/O6r and library/actions-925b6b8896d2.js (2026-10-18).
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_STATE = 16 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,1023}$/;
const FILE_ID = /^file[-_][A-Za-z0-9_-]+$/;
const PHASES = new Set(['prepared', 'reserving', 'reserved', 'uploading', 'uploading_parts', 'committing', 'uploaded', 'processing', 'processed', 'moving', 'moved', 'complete']);
const UNKNOWN = new Set(['reserving', 'uploading', 'committing', 'processing', 'moving']);
const MULTIPART_RESUME = new Set(['uploading_parts']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code, message, details) { throw new DotError(code, message, details); }
function id(value, label) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_ARGUMENT', `${label} must be an API-issued identifier.`); return value; }
function mime(value) { if (typeof value !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/u.test(value) || value.length>200) fail('INVALID_ARGUMENT', 'mimeType must be a supported MIME type.'); return value; }
function plain(value, label, limit=8192) { if (typeof value!=='string' || !value || value.length>limit || /[\x00-\x1f\x7f]/u.test(value)) fail('INVALID_ARGUMENT', `${label} must be bounded text without control characters.`); return value; }
async function statePath(value) { plain(value,'stateFile'); const requested=resolve(value), parent=await realpath(dirname(requested)).catch(()=>null); if(!parent)fail('INVALID_ARGUMENT','The state directory must exist.');return join(parent,basename(requested)); }
async function readState(file, missing=false) {
  let handle;
  try {
    handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));const before=await handle.stat();
    if(!before.isFile() || before.mode&0o077 || before.size>MAX_STATE || process.getuid && before.uid!==process.getuid())fail('INVALID_UPLOAD_STATE','The upload state must be an owner-only regular file of at most16 MiB.');
    const bytes=Buffer.alloc(Math.min(before.size+1,MAX_STATE+1));let length=0;while(length<bytes.length){const next=await handle.read(bytes,length,bytes.length-length,length);if(!next.bytesRead)break;length+=next.bytesRead;}
    const after=await handle.stat();if(length!==before.size || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs)fail('INVALID_UPLOAD_STATE','The upload state changed while being read.');
    const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));
    if(!object(state)||state.schemaVersion!==1||state.kind!=='native-library-upload'||!PHASES.has(state.phase)||!object(state.identity)||!object(state.source)||!object(state.reservation)||!object(state.processing)||!object(state.context)
      ||!ID.test(state.identity.accountId??'')||typeof state.identity.subject!=='string'||!state.identity.subject||typeof state.operationId!=='string')fail('INVALID_UPLOAD_STATE','Unsupported upload state.');
    if(state.reservation.fileId!=null&&!FILE_ID.test(state.reservation.fileId)||state.processing.libraryFileId!=null&&!ID.test(state.processing.libraryFileId))fail('INVALID_UPLOAD_STATE','Invalid recorded upload identity.');
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(state.operationId)
      ||typeof state.source.path!=='string'||typeof state.source.name!=='string'||!state.source.name||/[\x00-\x1f\x7f\\/]/u.test(state.source.name)
      ||typeof state.source.mimeType!=='string'||!/^[\w.+-]+\/[\w.+-]+$/u.test(state.source.mimeType)
      ||!Number.isSafeInteger(state.source.sizeBytes)||state.source.sizeBytes<1||state.source.sizeBytes>MAX_BYTES||!/^[a-f0-9]{64}$/u.test(state.source.sha256??'')
      ||state.context.directoryId!==null&&!ID.test(state.context.directoryId??'')
      ||!['prepared','reserving'].includes(state.phase)&&!FILE_ID.test(state.reservation.fileId??'')
      ||['processed','moving','moved','complete'].includes(state.phase)&&!ID.test(state.processing.libraryFileId??''))fail('INVALID_UPLOAD_STATE','The saved upload identity, source or phase is invalid.');
    if(state.transfer)validateTransfer(state);
    else if(MULTIPART_RESUME.has(state.phase)||state.phase==='committing')fail('INVALID_UPLOAD_STATE','A multipart phase requires a verified part map.');
    return state;
  }catch(error){if(missing&&error.code==='ENOENT')return null;if(error instanceof DotError)throw error;fail('INVALID_UPLOAD_STATE','Cannot read the private upload state.');}finally{await handle?.close();}
}
function storageUrl(value) {
  plain(value,'upload URL',16384);let url;try{url=new URL(value);}catch{fail('INVALID_RESPONSE','Invalid storage upload URL.');}
  const allowed=url.hostname==='files.oaiusercontent.com'||/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname)||/^sdmntpr[a-z0-9-]+\.oaiusercontent\.com$/.test(url.hostname)||/^(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname);
  if(url.protocol!=='https:'||!allowed||url.username||url.password||url.port||url.hash||/[\s\\]/u.test(value)||!['sig','X-Amz-Signature','x-amz-signature','Signature'].some(key=>!!url.searchParams.get(key)))fail('INVALID_RESPONSE','The reservation returned an unverified signed upload URL.');return url;
}
function uploadTarget(value) {
  plain(value,'upload URL',16384);let url;try{url=new URL(value,'https://chatgpt.com');}catch{fail('INVALID_RESPONSE','Invalid upload URL.');}
  if(url.origin==='https://chatgpt.com'&&url.pathname==='/backend-api/estuary/upload_content_bytes'&&!url.username&&!url.password&&!url.hash){
    const keys=[...url.searchParams.keys()];if(keys.length!==1||keys[0]!=='upload_url')fail('INVALID_RESPONSE','Unverified Estuary upload query.');const upstream=url.searchParams.get('upload_url');storageUrl(upstream);return{kind:'estuary',route:url.pathname,upstream};
  }
  return{kind:'signed',url:storageUrl(value).href};
}
function headers(value) { if(value==null)return{};if(!object(value)||Object.keys(value).length>30||Object.entries(value).some(([key,item])=>typeof item!=='string'||key.length>128||item.length>8192||/[\r\n\0]/u.test(key+item)||['__proto__','constructor','prototype'].includes(key)))fail('INVALID_RESPONSE','Invalid required upload headers.');return{...value}; }
function strategy(value){if(value==null)return null;return object(value)?Object.fromEntries(['kind','part_size_bytes','part_count','max_part_concurrency'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]])):{unsupported:true};}
function multipartStrategy(value,size){
  if(value==null)return null;
  if(!object(value)||value.kind!=='direct_azure_multipart'||!Number.isSafeInteger(value.part_size_bytes)||value.part_size_bytes<1
    ||!Number.isSafeInteger(value.part_count)||value.part_count<2||value.part_count>50000||!Number.isSafeInteger(value.max_part_concurrency)||value.max_part_concurrency<1
    ||Math.ceil(size/value.part_size_bytes)!==value.part_count)fail('UNSUPPORTED_UPLOAD_STRATEGY','The server returned an invalid or unsupported multipart plan. No bytes were sent.');
  return value;
}
function blockId(index){return Buffer.from(String(index).padStart(8,'0'),'ascii').toString('base64');}
function targetHash(value){return createHash('sha256').update(value).digest('hex');}

// Identical storage-transfer contracts reused by native project uploads.
// Processing receipts remain separate because project files need not have a
// persistent Library mapping. These helpers are not package entry exports.
export { uploadTarget as parseNativeUploadTarget, headers as validateNativeUploadHeaders,
  strategy as normalizeNativeUploadStrategy, multipartStrategy as validateNativeMultipartStrategy,
  blockId as nativeUploadBlockId, targetHash as nativeUploadTargetHash };
function validateTransfer(state){
  const transfer=state.transfer,plan=multipartStrategy(transfer?.strategy,state.source.sizeBytes);
  if(!plan||transfer.kind!=='azure_multipart'||transfer.fileId!==state.reservation.fileId||transfer.sourceSha256!==state.source.sha256
    ||transfer.directoryId!==state.context.directoryId||!/^[a-f0-9]{64}$/u.test(transfer.targetHash??'')
    ||state.reservation.uploadUrl&&transfer.targetHash!==targetHash(uploadTarget(state.reservation.uploadUrl).url??'')
    ||!Array.isArray(transfer.parts)||transfer.parts.length!==plan.part_count)fail('INVALID_UPLOAD_STATE','The saved multipart transfer is not bound to this file.');
  for(let i=0;i<transfer.parts.length;i++){
    const part=transfer.parts[i],offset=i*plan.part_size_bytes,length=Math.min(plan.part_size_bytes,state.source.sizeBytes-offset);
    if(!object(part)||part.index!==i||part.offset!==offset||part.length!==length||part.blockId!==blockId(i)||!/^[a-f0-9]{64}$/u.test(part.sha256??'')
      ||!['pending','inflight','uploaded'].includes(part.status))fail('INVALID_UPLOAD_STATE','The saved multipart part map is invalid.');
  }
}
function processingReceipt(text,fileId) {
  const receipt={completed:false,eventCount:0,eventNames:[]};let readyFileId;
  if(typeof text!=='string'||Buffer.byteLength(text)>2*1024*1024)return{...receipt,error:'INVALID_RESPONSE'};
  for(const line of text.split('\n')){
    if(!line.trim())continue;if(++receipt.eventCount>10000){receipt.error='INVALID_RESPONSE';break;}
    let event;try{event=JSON.parse(line.replace(/\r$/u,''));}catch{receipt.error='INVALID_RESPONSE';break;}
    if(!object(event)||typeof event.event!=='string'||event.file_id!=null&&event.file_id!==fileId){receipt.error='INVALID_RESPONSE';break;}
    if(/^[a-z][a-z0-9_.:-]{0,127}$/iu.test(event.event)&&receipt.eventNames.length<256&&!receipt.eventNames.includes(event.event))receipt.eventNames.push(event.event);
    if(event.event==='file.processing.file_ready')readyFileId=event.file_id;
    const rawFallback=event.event==='file.indexing.error'&&event.file_id===fileId&&readyFileId===fileId&&event.extra?.raw_file_fallback_available===true;
    if(/(?:^|\.)(?:error|cancelled|failed|unknown)$/u.test(event.event)&&!rawFallback){
      receipt.error='UPLOAD_PROCESSING_ERROR';
      if(/^[a-z][a-z0-9_.:-]{0,127}$/iu.test(event.event))receipt.failureEvent=event.event;
      if(typeof event.extra?.error_code==='string'&&/^[a-z0-9_.:-]{1,128}$/iu.test(event.extra.error_code))receipt.failureCode=event.extra.error_code;
      break;
    }
    if(event.extra?.library_persistence_result==='temporary'){receipt.error='UPLOAD_PERSISTENCE_REQUIRED';break;}
    if(event.extra?.metadata_object_id!=null){if(!ID.test(event.extra.metadata_object_id)||receipt.libraryFileId&&receipt.libraryFileId!==event.extra.metadata_object_id){receipt.error='INVALID_RESPONSE';break;}receipt.libraryFileId=event.extra.metadata_object_id;}
    if(event.extra?.library_file_name!=null){if(typeof event.extra.library_file_name!=='string'||event.extra.library_file_name.length>1024){receipt.error='INVALID_RESPONSE';break;}receipt.libraryFileName=event.extra.library_file_name;}
    if(event.extra?.mime_type!=null){try{receipt.mimeType=mime(event.extra.mime_type);}catch{receipt.error='INVALID_RESPONSE';break;}}
    if(event.event==='file.processing.completed'){if(event.file_id!==fileId){receipt.error='INVALID_RESPONSE';break;}receipt.completed=true;}
    if(rawFallback){receipt.completed=true;receipt.retrievalIndexingUnavailable=true;}
  }
  if(!receipt.error&&(!receipt.completed||!receipt.libraryFileId))receipt.error='UPLOAD_READBACK_PENDING';return receipt;
}
function result(state,file) {
  const completed=state.phase==='complete';return{accountId:state.identity.accountId,fileId:state.reservation.fileId??null,libraryFileId:state.processing.libraryFileId??null,phase:state.phase,
    status:completed?'complete':MULTIPART_RESUME.has(state.phase)?'partial_upload':UNKNOWN.has(state.phase)?'outcome_unknown':state.phase==='processed'&&state.context.directoryId!==null?'awaiting_move':state.phase==='processed'||state.phase==='moved'?'awaiting_readback':state.phase==='reserved'&&state.reservation.metadataValid!==true?'invalid_reservation':'ready_to_resume',completed,
    canResume:['prepared','uploaded','processed','moved','complete'].includes(state.phase)||state.phase==='reserved'&&state.reservation.metadataValid===true,canReconcile:!!state.reservation.fileId,stateFile:file,
    canResumeParts:MULTIPART_RESUME.has(state.phase),
    name:state.processing.libraryFileName??state.source.name,mimeType:state.processing.mimeType??state.source.mimeType,sizeBytes:state.source.sizeBytes,sha256:state.source.sha256,directoryId:state.context.directoryId,
    ...(state.context.directoryId!==null&&['processed','moving'].includes(state.phase)?{stagedAtRoot:true}:{}),
    ...(state.transfer?{transfer:{kind:state.transfer.kind,parts:state.transfer.parts.length,uploadedParts:state.transfer.parts.filter(part=>part.status==='uploaded').length}}:{}),
    ...(state.processing.retrievalIndexingUnavailable?{retrievalIndexingUnavailable:true,indexingStatus:'unavailable',indexed:false}:{})};
}

export class LibraryUpload {
  constructor(client){if(typeof client?.transport?.request!=='function')throw new TypeError('LibraryUpload requires a DotClient.');this.transport=client.transport;this.library=new DotLibrary(client);}
  async identity(expectedAccountId){
    id(expectedAccountId,'expectedAccountId');if(typeof this.transport.authLoader!=='function')fail('AUTH_IDENTITY_REQUIRED','A native Library upload requires authenticated account identity.');
    const auth=await this.transport.authLoader({authFile:this.transport.authFile});let subject;try{subject=JSON.parse(Buffer.from(auth.accessToken.split('.')[1],'base64url').toString('utf8')).sub;}catch{}
    if(auth.accountId!==expectedAccountId||typeof subject!=='string'||!subject)fail('ACCOUNT_CHANGED','The signed-in account does not match this upload.');this.transport.assertIdentity?.(auth);return{accountId:auth.accountId,subject};
  }
  async verifyIdentity(state,expectedAccountId){const current=await this.identity(expectedAccountId);if(current.accountId!==state.identity.accountId||current.subject!==state.identity.subject)fail('ACCOUNT_CHANGED','This upload belongs to a different signed-in identity.');return current;}
  async request(method,path,state,options={}){await this.verifyIdentity(state,state.identity.accountId);return this.transport.request(method,path,{...options,expectedAccountId:state.identity.accountId});}
  async save(file,state,phase,patch={},acknowledged=false){
    const next={...state,...patch,phase};try{const serialized=JSON.stringify(next,null,2)+'\n';if(Buffer.byteLength(serialized)>MAX_STATE)fail('INVALID_UPLOAD_STATE','The upload journal exceeds its bounded size.');await writePrivate(file,serialized,{overwrite:true});return next;}
    catch(error){fail('UPLOAD_RECEIPT_NOT_SAVED',acknowledged?'The service replied but its receipt could not be saved. Do not repeat this upload.':'The upload journal could not be saved; no further request was sent.',{phase,delivery:acknowledged?'acknowledged':'not_sent',fileId:next.reservation.fileId??null,libraryFileId:next.processing.libraryFileId??null,reason:error.code??'WRITE_FAILED'});}
  }
  async checkDirectory(state,signal){if(state.context.directoryId===null)return;const path=await this.library.directoryPath({directoryId:state.context.directoryId,signal});await this.verifyIdentity(state,state.identity.accountId);if(!path.items.some(item=>item.id===state.context.directoryId&&!item.id.startsWith('external-')))fail('INVALID_ARGUMENT','The upload directory must be an accessible native Library folder.');}
  async verifyMapping(state,signal,{allowRoot=false}={}){
    const libraryFileId=state.processing.libraryFileId;if(!libraryFileId)fail('UPLOAD_READBACK_PENDING','No persistent Library identity has been confirmed.');
    const entry=await this.library.get({fileId:libraryFileId,signal});await this.verifyIdentity(state,state.identity.accountId);
    const name=state.processing.libraryFileName??state.source.name,folder=entry.parent_directory_id??entry.directory_id??null;
    let directoryMatches=folder===state.context.directoryId;
    if(!directoryMatches&&(state.context.directoryId===null||allowRoot)){
      // A root upload omits directory_id, while node metadata can return the
      // concrete native root ID. Resolve that root; never accept any folder.
      const path=await this.library.directoryPath({signal});await this.verifyIdentity(state,state.identity.accountId);
      directoryMatches=path.items.length===1&&path.items[0].is_root===true&&path.items[0].id===folder;
    }
    if(entry.id!==libraryFileId||entry.file_id!==state.reservation.fileId||(entry.file_name??entry.name)!==name||entry.file_size_bytes!==state.source.sizeBytes||!directoryMatches||entry.kind==='directory')fail('INVALID_RESPONSE','The uploaded Library record does not match the saved file and destination.');
    if(entry.state!=='ready')fail('UPLOAD_READBACK_PENDING','The uploaded Library record is not ready yet. Reconcile this state without repeating the upload.');return entry;
  }
  async finish(file,state,signal){
    const entry=await this.verifyMapping(state,signal,{allowRoot:state.phase==='processed'});
    if(state.context.directoryId!==null&&(entry.parent_directory_id??entry.directory_id??null)!==state.context.directoryId){
      await this.checkDirectory(state,signal);await this.verifyIdentity(state,state.identity.accountId);signal?.throwIfAborted();
      state=await this.save(file,state,'moving');
      const receipt=await this.request('PATCH',`/backend-api/files/library/files/${encodeURIComponent(state.processing.libraryFileId)}/move`,state,{body:{directory_id:state.context.directoryId},signal});
      if(receipt?.success!==true)fail('MUTATION_UNCONFIRMED','The file move was not confirmed. Reconcile the saved upload; do not repeat the move.');
      state=await this.save(file,state,'moved',{},true);await this.verifyMapping(state,signal);
    }
    state=await this.save(file,state,'complete');return state;
  }
  async multipart(file,state,source,signal){
    const plan=multipartStrategy(state.reservation.uploadStrategy,state.source.sizeBytes),target=uploadTarget(state.reservation.uploadUrl);
    const host=target.kind==='signed'?new URL(target.url).hostname:'';
    if(!plan||target.kind!=='signed'||!(/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(host)||/^sdmntpr[a-z0-9-]+\.oaiusercontent\.com$/.test(host))
      ||[...new URL(target.url).searchParams.keys()].some(key=>['x-amz-algorithm','comp','blockid'].includes(key.toLowerCase())))fail('UNSUPPORTED_UPLOAD_STRATEGY','Azure multipart requires its original signed Azure reservation.');
    if(typeof this.transport.uploadAzureBlock!=='function'||typeof this.transport.commitAzureBlocks!=='function')fail('UNSUPPORTED_TRANSPORT','This transport cannot perform native Azure multipart uploads.');
    if(!state.transfer){
      const parts=[];
      for(let index=0;index<plan.part_count;index++){
        const offset=index*plan.part_size_bytes,length=Math.min(plan.part_size_bytes,source.sizeBytes-offset);
        const range=await prepareVerifiedUploadRange(source,{start:offset,endExclusive:offset+length,signal});
        parts.push({index,blockId:blockId(index),offset,length,sha256:range.sha256,status:'pending'});
      }
      state=await this.save(file,state,'reserved',{transfer:{kind:'azure_multipart',strategy:plan,fileId:state.reservation.fileId,sourceSha256:source.sha256,directoryId:state.context.directoryId,targetHash:targetHash(target.url),parts}});
    }
    validateTransfer(state);await this.verifyIdentity(state,state.identity.accountId);signal?.throwIfAborted();
    if(state.phase!=='committing'){
      state=await this.save(file,state,'uploading_parts');
      let chain=Promise.resolve(),next=0,firstError;
      const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
      const persist=(index,status,acknowledged=false)=>{
        const operation=chain.then(async()=>{const parts=state.transfer.parts.map((part,i)=>i===index?{...part,status}:part);state=await this.save(file,state,'uploading_parts',{transfer:{...state.transfer,parts}},acknowledged);});
        chain=operation.catch(()=>{});return operation;
      };
      const worker=async()=>{
        try{
          for(;;){
            combined.throwIfAborted();const index=next++;if(index>=state.transfer.parts.length)return;
            const part=state.transfer.parts[index];if(part.status==='uploaded')continue;
            const range=await prepareVerifiedUploadRange(source,{start:part.offset,endExclusive:part.offset+part.length,signal:combined});
            if(range.sha256!==part.sha256)fail('UPLOAD_SOURCE_MISMATCH','A multipart source range changed. No further block was sent.');
            await this.verifyIdentity(state,state.identity.accountId);combined.throwIfAborted();await persist(index,'inflight');
            combined.throwIfAborted();await this.transport.uploadAzureBlock(target.url,{...range,blockId:part.blockId,contentType:source.mimeType,signal:combined,timeoutMs:600000});
            await persist(index,'uploaded',true);
          }
        }catch(error){firstError??=error;controller.abort(error);}
      };
      await Promise.allSettled(Array.from({length:Math.min(5,plan.max_part_concurrency,plan.part_count)},worker));await chain;
      if(firstError)throw firstError;
      if(state.transfer.parts.some(part=>part.status!=='uploaded'))fail('UPLOAD_OUTCOME_UNKNOWN','Not every upload part was acknowledged.');
      await this.verifyIdentity(state,state.identity.accountId);signal?.throwIfAborted();state=await this.save(file,state,'committing');
    }
    // A commit is issued once. If its outcome is uncertain, the public upload
    // entry point refuses to re-enter this phase and permits only readback.
    if(state.transfer.parts.some(part=>part.status!=='uploaded'))fail('INVALID_UPLOAD_STATE','The multipart commit requires every acknowledged block.');
    await this.verifyIdentity(state,state.identity.accountId);signal?.throwIfAborted();
    await this.transport.commitAzureBlocks(target.url,{blockIds:state.transfer.parts.map(part=>part.blockId),contentType:source.mimeType,signal,timeoutMs:120000});
    return this.save(file,state,'uploaded',{reservation:{fileId:state.reservation.fileId}},true);
  }
  async status({stateFile,expectedAccountId}={}){const file=await statePath(stateFile),state=await readState(file);await this.verifyIdentity(state,expectedAccountId);return result(state,file);}
  async upload({file:sourceFile,stateFile,expectedAccountId,directoryId,mimeType,resumeParts=false,signal}={}){
    const file=await statePath(stateFile);return withOperationLock(file,async()=>{
      let state=await readState(file,true);const identity=await this.identity(expectedAccountId);
      if(state)await this.verifyIdentity(state,expectedAccountId);
      if(directoryId!==undefined&&directoryId!==null)id(directoryId,'directoryId');
      const selectedDirectory=directoryId===undefined?state?.context.directoryId??null:directoryId;
      if(typeof resumeParts!=='boolean')fail('INVALID_ARGUMENT','resumeParts must be boolean.');
      const payload=await readLibraryUploadSource(sourceFile,{mimeType:mimeType??state?.source.mimeType,signal});
      if(payload.source.path===file||payload.source.path===file+'.lock')fail('INVALID_ARGUMENT','Source and state must be separate files.');
      if(state){
        if(state.context.directoryId!==selectedDirectory||Object.keys(payload.source).some(key=>key!=='mimeResolutionSource'&&state.source[key]!==payload.source[key]))fail('UPLOAD_SOURCE_MISMATCH','This journal belongs to a different source file or destination.');
        if(UNKNOWN.has(state.phase))fail('UPLOAD_OUTCOME_UNKNOWN','A prior upload write has an uncertain outcome. Use library upload-reconcile; it will not replay the write.',{phase:state.phase,fileId:state.reservation.fileId??null,libraryFileId:state.processing.libraryFileId??null});
        if(MULTIPART_RESUME.has(state.phase)&&!resumeParts)fail('UPLOAD_OUTCOME_UNKNOWN','This multipart upload was interrupted. Only an explicit --resume-parts may repeat its unchanged deterministic uncommitted blocks.',{phase:state.phase,fileId:state.reservation.fileId});
      }else{
        if(resumeParts)fail('INVALID_ARGUMENT','resumeParts requires an existing interrupted multipart journal.');
        state={schemaVersion:1,kind:'native-library-upload',operationId:randomUUID(),identity,source:payload.source,context:{directoryId:selectedDirectory},phase:'prepared',reservation:{},processing:{}};
        await writePrivate(file,JSON.stringify(state,null,2)+'\n');
      }
      if(state.phase==='complete')return result(state,file);
      if(state.phase==='prepared'){
        await this.verifyIdentity(state,expectedAccountId);await this.checkDirectory(state,signal);state=await this.save(file,state,'reserving');
        signal?.throwIfAborted();const response=await this.request('POST','/backend-api/files',state,{signal,body:{entry_surface:'codex_library_upload',file_name:state.source.name,file_size:state.source.sizeBytes,client_resolved_mime_type:state.source.mimeType,mime_resolution_source:state.source.mimeResolutionSource,mime_type:state.source.mimeType,reset_rate_limits:false,supports_direct_azure_multipart:true,timezone_offset_min:new Date().getTimezoneOffset(),upload_source:'codex_library_upload',use_case:'my_files',store_in_library:true,library_persistence_mode:'required'}});
        // Preserve the returned identifier before validating optional upload
        // metadata, so even a malformed response remains reconcilable.
        const reservation={...(FILE_ID.test(response?.file_id??'')?{fileId:response.file_id}:{}),...(typeof response?.upload_url==='string'&&response.upload_url.length<=16384?{uploadUrl:response.upload_url}:{}),requiredHeaders:{},uploadStrategy:strategy(response?.direct_library_upload_strategy),metadataValid:false};
        state=await this.save(file,state,reservation.fileId?'reserved':'reserving',{reservation},true);
        if(!reservation.fileId||!reservation.uploadUrl||response?.status==='error')fail('INVALID_RESPONSE','The file reservation was incomplete. Inspect the saved state; do not reserve again.');uploadTarget(reservation.uploadUrl);
        state=await this.save(file,state,'reserved',{reservation:{...reservation,requiredHeaders:headers(response?.upload_headers),metadataValid:true}});
      }
      if(state.phase==='reserved'||MULTIPART_RESUME.has(state.phase)){
        if(state.reservation.metadataValid!==true)fail('INVALID_RESPONSE','Stored reservation metadata is invalid or incomplete. No bytes were sent; inspect or reconcile the saved reservation.');
        const target=uploadTarget(state.reservation.uploadUrl);
        const plan=multipartStrategy(state.reservation.uploadStrategy,state.source.sizeBytes);
        if(plan){
          state=await this.multipart(file,state,payload.source,signal);
        }else{
          if(MULTIPART_RESUME.has(state.phase))fail('INVALID_UPLOAD_STATE','An interrupted multipart upload cannot become a whole-file upload.');
          if(target.kind==='signed'&&typeof this.transport.uploadSignedFile!=='function'||target.kind==='estuary'&&typeof this.transport.uploadEstuaryFile!=='function')fail('UNSUPPORTED_TRANSPORT','The transport does not support file-backed uploads.');
          validateStorageUploadHeaders(state.reservation.requiredHeaders);await this.verifyIdentity(state,expectedAccountId);signal?.throwIfAborted();state=await this.save(file,state,'uploading');
          if(target.kind==='signed')await this.transport.uploadSignedFile(target.url,{source:payload.source,contentType:state.source.mimeType,requiredHeaders:state.reservation.requiredHeaders,signal,timeoutMs:600000});
          else await this.transport.uploadEstuaryFile(target.upstream,{source:payload.source,expectedAccountId:state.identity.accountId,signal,timeoutMs:600000});
          state=await this.save(file,state,'uploaded',{reservation:{fileId:state.reservation.fileId}},true);
        }
      }
      if(state.phase==='uploaded'){
        await this.verifyIdentity(state,expectedAccountId);signal?.throwIfAborted();state=await this.save(file,state,'processing');
        // The current service cannot resolve new native folders during direct
        // processing. Persist at root, then move the acknowledged Library ID.
        const stream=await this.request('POST','/backend-api/files/process_upload_stream',state,{signal,responseType:'text',maxBytes:2*1024*1024,timeoutMs:600000,body:{entry_surface:'codex_library_upload',file_id:state.reservation.fileId,file_name:state.source.name,index_for_retrieval:true,library_persistence_mode:'required',metadata:{store_in_library:true},mime_type:state.source.mimeType,upload_source:'codex_library_upload',use_case:'my_files'}});
        const processing=processingReceipt(stream,state.reservation.fileId);state=await this.save(file,state,'processing',{processing},true);
        if(processing.error)fail(processing.error,'Processing did not confirm a completed persistent Library file. Reconcile the saved state; do not repeat the upload.');
        state=await this.save(file,state,'processed');
      }
      state=await this.finish(file,state,signal);return result(state,file);
    },{label:'Library upload',busyCode:'UPLOAD_BUSY',failedCode:'UPLOAD_BUSY'});
  }
  async reconcile({stateFile,expectedAccountId,signal}={}){
    const file=await statePath(stateFile);return withOperationLock(file,async()=>{
      let state=await readState(file);await this.verifyIdentity(state,expectedAccountId);
      if(!state.reservation.fileId)return{...result(state,file),reconciled:false,reason:'No file ID was received; another reservation is not safe.'};
      if(!state.processing.libraryFileId){
        const matches=[],seen=new Set();let cursor,complete=false;
        for(let page=0;page<10;page++){
          const response=await this.library.search({limit:100,cursor,signal});await this.verifyIdentity(state,expectedAccountId);
          matches.push(...response.items.filter(item=>item.file_id===state.reservation.fileId));if(response.cursor===null){complete=true;break;}
          if(seen.has(response.cursor))fail('INVALID_RESPONSE','The Library search repeated a cursor.');seen.add(response.cursor);cursor=response.cursor;
        }
        const unique=[...new Map(matches.map(item=>[item.id,item])).values()];if(unique.length>1)fail('INVALID_RESPONSE','More than one Library entry refers to this upload; no mapping was selected.');
        if(!complete)return{...result(state,file),reconciled:false,searchComplete:false,reason:'The bounded Library search is incomplete; no unique mapping can be confirmed.'};
        if(!unique.length)return{...result(state,file),reconciled:false,searchComplete:complete,reason:'No persistent Library entry found. The previous write remains uncertain; no request was replayed.'};
        state=await this.save(file,state,state.phase,{processing:{...state.processing,libraryFileId:unique[0].id,libraryFileName:unique[0].file_name??unique[0].name}});
      }
      const entry=await this.verifyMapping(state,signal,{allowRoot:state.phase!=='complete'});
      if(state.context.directoryId!==null&&(entry.parent_directory_id??entry.directory_id??null)!==state.context.directoryId){
        if(!['moving','moved'].includes(state.phase))state=await this.save(file,state,'processed',{processing:{...state.processing,reconciled:true}});
        return{...result(state,file),reconciled:false,reason:['moving','moved'].includes(state.phase)?'The move is not visible yet; only the root-staged file is visible. The move was not repeated.':'The file is safely staged at root; resume upload to move it to the requested folder.'};
      }
      state=await this.save(file,state,'complete',{processing:{...state.processing,reconciled:true}});return{...result(state,file),reconciled:true};
    },{label:'Library upload',busyCode:'UPLOAD_BUSY',failedCode:'UPLOAD_BUSY'});
  }
}
