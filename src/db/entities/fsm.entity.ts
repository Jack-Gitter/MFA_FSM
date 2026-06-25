import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('machines')
export class FSM {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'jsonb' })
  snapshot: object;

  @Column({ type: 'jsonb', name: 'last_transition' })
  lastTransition: { prev: string; current: string };
}
