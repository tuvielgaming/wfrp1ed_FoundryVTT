export class Wfrp1edItem extends Item {
    prepareData(){
        super.prepareData();

        const itemData = this.data;
        const actorData = this.actor ? this.actor.data : {};
        const data = itemData.data;
    }
}