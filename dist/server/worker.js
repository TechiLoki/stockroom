export async function workerStep(db) {
    const job = await db.call('claim_batch');
    if (!job)
        return false;
    try {
        await db.call('apply_batch', { p_id: job.id, p_token: job.token });
    }
    catch {
        await db.call('fail_batch', { p_id: job.id, p_token: job.token });
    }
    return true;
}
export async function runWorker(db, signal) {
    while (!signal.aborted) {
        try {
            if (await workerStep(db))
                continue;
        }
        catch {
            console.error('Worker database operation failed; retrying.');
        }
        await new Promise(resolve => { const timer = setTimeout(done, 1000); function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); } signal.addEventListener('abort', done, { once: true }); });
    }
}
