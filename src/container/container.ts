import { ContainerBinding } from './container-binding';
import type { Registration } from './container.type';
import type { Token } from './token';

export class Container {
    private bindings = new Map<Token<unknown>, ContainerBinding<unknown>>();

    constructor(private readonly parent: Container | null = null) {}

    register<T>(token: Token<T>, registration: Registration<T>) {
        if (this.bindings.has(token)) {
            throw new Error(`${token.toString()} is already registered.`);
        }

        this.bindings.set(token, new ContainerBinding(registration));
    }

    resolve<T>(token: Token<T>): T {
        const binding = this.bindings.get(token) as ContainerBinding<T> | undefined;
        if (binding) {
            return binding.resolve(this);
        }

        if (this.parent) {
            return this.parent.resolve(token);
        }

        throw new Error(`${token.toString()} is not registered.`);
    }

    createChild(): Container {
        return new Container(this)
   }
}