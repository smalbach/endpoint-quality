import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { EndpointExampleEntity } from "@/shared/database/entities";
import type { EndpointExample } from "../../domain/examples";
import type { ExampleRepositoryPort } from "../../domain/ports";

/** Las columnas `jsonb` se tipan aquí, una vez. Lo que llevan se validó al entrar. */
const toExample = (row: EndpointExampleEntity): EndpointExample => row as unknown as EndpointExample;

@Injectable()
export class TypeOrmExampleRepository implements ExampleRepositoryPort {
  constructor(@InjectRepository(EndpointExampleEntity) private readonly examples: Repository<EndpointExampleEntity>) {}

  async listByEndpoint(projectId: string, endpointId: string): Promise<EndpointExample[]> {
    const rows = await this.examples.find({
      where: { projectId, endpointId },
      // `orderIndex` y luego la fecha: el orden lo pone quien los guarda, y a igualdad manda el
      // más viejo, que es el que llevaba ahí más tiempo documentando el endpoint.
      order: { orderIndex: "ASC", createdAt: "ASC" },
    });
    return rows.map(toExample);
  }

  async listByProject(projectId: string): Promise<EndpointExample[]> {
    const rows = await this.examples.find({
      where: { projectId },
      order: { endpointId: "ASC", orderIndex: "ASC", createdAt: "ASC" },
    });
    return rows.map(toExample);
  }

  async findById(projectId: string, id: string): Promise<EndpointExample | null> {
    // `projectId` va en el `where` aunque `id` sea la clave: un id de otro inquilino tiene que no
    // encontrar nada, y no basta con que el manejador «sepa» de quién es.
    const row = await this.examples.findOne({ where: { id, projectId } });
    return row ? toExample(row) : null;
  }

  async save(example: EndpointExample): Promise<void> {
    await this.examples.save(this.examples.create(example as unknown as EndpointExampleEntity));
  }

  async saveMany(examples: EndpointExample[]): Promise<void> {
    if (!examples.length) return;
    await this.examples.save(
      examples.map((example) => this.examples.create(example as unknown as EndpointExampleEntity)),
    );
  }

  async remove(projectId: string, id: string): Promise<boolean> {
    const result = await this.examples.delete({ id, projectId });
    return Boolean(result.affected);
  }

  async countByEndpoint(projectId: string, endpointId: string): Promise<number> {
    return this.examples.count({ where: { projectId, endpointId } });
  }
}
