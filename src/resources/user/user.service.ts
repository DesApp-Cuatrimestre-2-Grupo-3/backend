import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CreateUserDto, UpdateUserDto } from 'cartelera-unahur';
import { User } from 'src/entities/user.entity';
import { Brackets, IsNull, Repository } from 'typeorm';
import { hash } from 'bcrypt';
import axios from 'axios';
@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  private readonly keycloakUrl =
    process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
  private readonly realm = process.env.KEYCLOAK_REALM ?? 'cartelera';
  private readonly clientId =
    process.env.KEYCLOAK_CLIENT_ID ?? 'cartelera-back';
  private readonly clientSecret =
    process.env.KEYCLOAK_CLIENT_SECRET ?? 'qt77AIDXQGu2aQ4hU3thTstcuXxk2Eoz';

  public async create(createUserDto: CreateUserDto) {
    const newUser = this.userRepository.create(createUserDto);
    const { dni } = newUser;

    // Verificar si el usuario ya existe en la base de datos
    const userFound = await this.getUserByDni(dni);
    if (userFound) {
      throw new HttpException('User already exists', HttpStatus.BAD_REQUEST);
    }

    // Guardar el usuario en la base de datos
    const savedUser = await this.userRepository.save(newUser);

    // Intentar crear el usuario en Keycloak
    try {
      const token = await this.getKeycloakToken();
      await this.createUserInKeycloak(createUserDto, token);
    } catch (error) {
      // Si ocurre un error, eliminar el usuario de la base de datos
      await this.userRepository.delete(savedUser.id);
      throw new HttpException(
        'Failed to create user in Keycloak',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return savedUser;
  }

  private async getKeycloakToken(): Promise<string> {
    try {
      const response = await axios.post(
        `${this.keycloakUrl}/realms/${this.realm}/protocol/openid-connect/token`,
        new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );
      return response.data.access_token;
    } catch (error) {
      console.error(
        'Error obteniendo el token:',
        error.response?.data || error.message,
      );
      throw new HttpException(
        'Failed to obtain Keycloak token',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async createUserInKeycloak(
    createUserDto: CreateUserDto,
    token: string,
  ) {
    const keycloakUser = {
      username: createUserDto.name,
      enabled: true,
      attributes: {
        DNI: createUserDto.dni,
      },
      credentials: [
        {
          type: 'password',
          value: createUserDto.password, // Solo se envía si deseas establecer una contraseña inicial
          temporary: false, // Configura la contraseña como temporal para que el usuario deba cambiarla en el primer inicio de sesión
        },
      ],
    };

    try {
      const response = await axios.post(
        `${this.keycloakUrl}/admin/realms/${this.realm}/users`,
        keycloakUser,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );

      // Obtener el ID del usuario desde la cabecera 'Location'
      const keycloakUserId = response.headers['location'].split('/').pop();

      // Ahora actualizas tu base de datos con el idKeycloak
      await this.userRepository.update(
        { dni: createUserDto.dni }, // Asumiendo que 'dni' es único
        { idKeycloak: keycloakUserId },
      );
    } catch (error) {
      throw new HttpException(
        'Failed to create user in Keycloak',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  public async getUserByDni(dni: string): Promise<User | undefined> {
    return this.userRepository.findOne({ where: { dni } });
  }

  public async findAll() {
    return this.userRepository.find({
      where: { deletedAt: IsNull() },
      relations: { role: true },
      order: { id: 'DESC' },
    });
  }

  public async findPageAndLimit(page: number, limit: number, search = '') {
    const offset = (page - 1) * limit;
    const applySearchFilter = (qb) => {
      if (search.length > 1) {
        qb.andWhere(
          new Brackets((qb2) => {
            qb2
              .where('LOWER(u."name") LIKE LOWER(:searchTerm)', {
                searchTerm: `%${search}%`,
              })
              .orWhere('LOWER(u."dni") LIKE LOWER(:searchTerm)', {
                searchTerm: `%${search}%`,
              })
              .orWhere('LOWER(rl."name") LIKE LOWER(:searchTerm)', {
                searchTerm: `%${search}%`,
              });
          }),
        );
      }
    };
    const query = this.userRepository
      .createQueryBuilder('u')
      .select([
        'u.*',
        `jsonb_build_object(
           'id', rl.id,
           'name', rl."name"
         ) AS "role"`,
      ])
      .innerJoin('Role', 'rl', 'rl.id = u."roleId"')
      .where('u."deletedAt" IS NULL')
      .offset(offset)
      .limit(limit);

    applySearchFilter(query);

    const data = await query.getRawMany();
    const totalQuery = this.userRepository
      .createQueryBuilder('u')
      .select('COUNT(*)', 'count')
      .innerJoin('Role', 'rl', 'rl.id = u."roleId"')
      .where('u."deletedAt" IS NULL');

    applySearchFilter(totalQuery);

    const totalResult = await totalQuery.getRawOne();
    const total = parseInt(totalResult.count, 10);
    const totalPages = Math.ceil(total / limit);

    return {
      data,
      page,
      total,
      limit,
      totalPages,
    };
  }

  public async findOne(id: number) {
    try {
      return this.userRepository.find({ where: { id } });
    } catch (error) {
      throw new HttpException('User not found', HttpStatus.BAD_REQUEST);
    }
  }

  public async findByIdKeycloak(idKeycloak: string) {
    try {
      return this.userRepository.find({
        where: { idKeycloak: idKeycloak.toString() },
        relations: { role: true },
      });
    } catch (error) {
      throw new HttpException('User not found', HttpStatus.BAD_REQUEST);
    }
  }

  public async update(id: number, updateUserDto: UpdateUserDto) {
    const { password } = updateUserDto;
    const plainToHash = await hash(password, 12);
    updateUserDto = { ...updateUserDto, password: plainToHash };
    try {
      return this.userRepository.update({ id }, updateUserDto);
    } catch (error) {
      throw new HttpException('Error on update', HttpStatus.BAD_REQUEST);
    }
  }

  public async remove(id: number) {
    try {
      return this.userRepository.update(
        { id },
        {
          id,
          deletedAt: new Date(),
        },
      );
    } catch (error) {
      throw new HttpException('Error on delete', HttpStatus.BAD_REQUEST);
    }
  }
}
