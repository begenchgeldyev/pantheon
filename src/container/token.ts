export class Token<T> {
    private readonly _type!: T;

    constructor(public readonly name: string) {}

    toString() {
        return `Token[${this.name}]`;
    }
}