import { ContainerBinding } from './container-binding';
import type { Registration } from './container.type';
import type { Token } from './token';

export class Container {
    private bindings = new Map<Token<unknown>, ContainerBinding<unknown>>();
    private resolving: Token<unknown>[] = [];

    constructor(private readonly parent: Container | null = null) { }

    register<T>(token: Token<T>, registration: Registration<T>) {
        if (this.bindings.has(token)) {
            throw new Error(`${token.toString()} is already registered.`);
        }

        this.bindings.set(token, new ContainerBinding(registration));
    }

    resolve<T>(token: Token<T>): T {
        const binding = this.bindings.get(token) as ContainerBinding<T> | undefined;

        if (!binding && this.parent) {
            return this.parent.resolve(token);
        }

        if (!binding) {
            throw new Error(`${token.toString()} is not registered.`);
        }

        if (this.resolving.includes(token)) {
            const chain = [...this.resolving, token].map(t => t.toString()).join(' -> ');
            throw new Error(`Circular dependency detected: ${chain}`);
        }

        this.resolving.push(token);
        try {
            return binding.resolve(this);
        } finally {
            this.resolving.pop();
        }
    }

    createChild(): Container {
        return new Container(this)
    }
}