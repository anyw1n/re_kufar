/** In-memory Firestore double with atomic commits and injectable write failures. */
export class FakeFirestore {
    documents = new Map();
    commits = [];
    failCommit = null;
    nextId = 0;

    collection(path) {
        return new FakeCollection(this, path);
    }

    async getAll(...refs) {
        return Promise.all(refs.map((ref) => ref.get()));
    }

    batch() {
        return new FakeWrites(this);
    }

    async runTransaction(callback) {
        const transaction = new FakeWrites(this);
        const result = await callback(transaction);
        await transaction.commit();
        return result;
    }

    commit(writes) {
        if (this.failCommit?.(writes)) {
            this.failCommit = null;
            throw new Error('simulated write failure');
        }
        this.commits.push(writes);
        for (const { ref, data, options } of writes) {
            this.documents.set(ref.path, structuredClone(options?.merge
                ? { ...this.documents.get(ref.path), ...data }
                : data));
        }
    }
}

class FakeWrites {
    writes = [];

    constructor(store) {
        this.store = store;
    }

    async get(ref) {
        if (this.writes.length > 0) throw new Error('read after write');
        return ref.get();
    }

    set(ref, data, options) {
        this.writes.push({ ref, data, options });
        return this;
    }

    async commit() {
        this.store.commit(this.writes);
    }
}

class FakeDocument {
    constructor(store, path) {
        this.store = store;
        this.path = path;
        this.id = path.split('/').at(-1);
    }

    collection(name) {
        return new FakeCollection(this.store, `${this.path}/${name}`);
    }

    async get() {
        const data = this.store.documents.get(this.path);
        return { id: this.id, ref: this, exists: data !== undefined, data: () => structuredClone(data) };
    }
}

class FakeCollection {
    constructor(store, path, filters = []) {
        this.store = store;
        this.path = path;
        this.filters = filters;
    }

    doc(id = `generated-${++this.store.nextId}`) {
        return new FakeDocument(this.store, `${this.path}/${id}`);
    }

    where(field, operator, value) {
        return new FakeCollection(this.store, this.path, [...this.filters, { field, operator, value }]);
    }

    async get() {
        const docs = [];
        for (const [path, data] of this.store.documents) {
            if (!path.startsWith(`${this.path}/`) || path.slice(this.path.length + 1).includes('/')) continue;
            if (!this.filters.every((filter) => matches(data, filter))) continue;
            docs.push(await new FakeDocument(this.store, path).get());
        }
        return { docs, size: docs.length };
    }
}

function matches(data, { field, operator, value }) {
    switch (operator) {
        case 'in': return value.includes(data[field]);
        case '>=': return data[field] >= value;
        case '<=': return data[field] <= value;
        default: throw new Error(`Unsupported fake query operator: ${operator}`);
    }
}
