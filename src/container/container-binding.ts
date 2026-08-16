import type { Container } from './container';
import type { Registration } from './container.type';

export class ContainerBinding<T> {
    private instance: T | undefined;

    constructor(private registration: Registration<T>) {}

    resolve(container: Container): T {
        if (this.registration.lifetime === 'transient') {
            return this.registration.factory(container);
        }

        if (this.instance === undefined) {
            this.instance = this.registration.factory(container);
        }
        
        return this.instance;
    }
}