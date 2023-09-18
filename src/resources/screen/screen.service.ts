import { Injectable } from '@nestjs/common';
import { CreateScreenDto, UpdateScreenDto } from 'cartelera-unahur';

@Injectable()
export class ScreenService {
  create(createScreenDto: CreateScreenDto) {
    return 'This action adds a new screen';
  }

  findAll() {
    return `This action returns all screen`;
  }

  findOne(id: number) {
    return `This action returns a #${id} screen`;
  }

  update(id: number, updateScreenDto: UpdateScreenDto) {
    return `This action updates a #${id} screen`;
  }

  remove(id: number) {
    return `This action removes a #${id} screen`;
  }
}
