import type { Container } from './container';

export type ContainerLifetime = 'singleton' | 'transient';

export interface Registration<T> {
    readonly factory: (container: Container) => T;
    readonly lifetime: ContainerLifetime;
}